# 错题本（错词攻坚）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 自动收集答错的词进入"错题本"，孩子从首页点进专门的错题练习会话，连对 2 次毕业；同时从上线起积累错拼事件日志。

**Architecture:** 错题本成员资格**不建状态表**，纯派生自 `user_word_state`（`lapses > 0 AND reps < 2`）；新增一张 append-only 的 `wrong_answer_events` 表由 `POST /api/review` 在答错时顺带写入；前端复用现有拼写会话，只换队列来源并带 `source`。

**Tech Stack:** Hono on Cloudflare Workers + D1，原生 JS ES module 前端，vitest with `@cloudflare/vitest-pool-workers`。

**Spec:** `docs/superpowers/specs/2026-08-23-mistake-book-design.md`

## Global Constraints

- 毕业阈值 `reps >= 2`；"已掌握"展示阈值 `MASTERY_REPS(3)` 不动——两个阈值并存，勿混淆。
- 错题在册条件（所有 SQL 统一）：`user_word_state WHERE user_id=? AND lapses > 0 AND reps < 2`。
- `wrong_answer_events` 写入失败绝不影响 `/api/review` 返回（try/catch + console.log）。
- 事件写入仅当 `correct === false`；`correct=true` 不写事件。
- `source` 白名单：`'daily' | 'unit' | 'mistake'`，否则存 NULL；`answer` 超 100 字符截断。
- 旧客户端不传 `source`/`answer` 完全兼容（列存 NULL）。
- `spellingCard` 的提交/判定/乐观上报流程不改，只给 `recordAnswer` 增加参数。
- `npm test` = `vitest run`（无单独 lint/typecheck 脚本）。
- 提交信息用仓库惯例的中文 conventional commits（`feat:`/`test:`/`docs:` 等）。

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `migrations/0002_mistake_events.sql` | Create | D1 迁移：错拼事件表 + 索引 |
| `test/schema.ts` | Modify | 同步迁移（verbatim 副本，workerd 内无 fs） |
| `src/kid.ts` | Modify | `/review` 写事件；新增 `/session/mistakes`；`/home` 加 `mistake_count` |
| `src/admin.ts` | Modify | 删词/深度重置级联清理事件表 |
| `public/review-client.js` | Modify | `recordAnswer` 透传 `source`/`answer`，新增 `onResult` 回调 |
| `public/mistake-helpers.js` | Create | 纯函数 `countGraduated`（无 DOM，可测） |
| `test/mistake-helpers.test.ts` | Create | `countGraduated` 单测 |
| `test/api.test.ts` | Modify | 事件记录/派生队列/级联清理集成测试 |
| `test/review-client.test.ts` | Modify | `source`/`answer`/`onResult` 单测 |
| `public/app.js` | Modify | 首页错题本卡片、`mistake` 会话模式、source 接线、毕业统计 |
| `public/style.css` | Modify | `.big:disabled` 禁用态样式 |

---

## Task 1: 迁移 + `/review` 记录错拼事件

**Files:**
- Create: `migrations/0002_mistake_events.sql`
- Modify: `test/schema.ts`
- Modify: `src/kid.ts:41-61`（`POST /review`）
- Test: `test/api.test.ts`

**Interfaces:**
- Produces（Task 2/3 依赖）：D1 表 `wrong_answer_events(id, user_id, word_id, answer, source, created_at)` + 索引 `idx_wrong_events(user_id, word_id)`。
- Produces（前端契约）：`POST /api/review` 请求体新增**可选** `source?: string`、`answer?: string`；响应不变。

- [ ] **Step 1: 创建迁移文件**

创建 `migrations/0002_mistake_events.sql`：

```sql
-- 错拼事件（append-only 日志，不参与错题本判定；判定纯派生自 user_word_state）
CREATE TABLE IF NOT EXISTS wrong_answer_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  word_id INTEGER NOT NULL,
  answer TEXT,
  source TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wrong_events ON wrong_answer_events(user_id, word_id);
```

- [ ] **Step 2: 同步 test/schema.ts**

在 `test/schema.ts` 的 `SCHEMA_SQL` 模板串中、`-- 星星 / 连击` 段之前插入（与迁移逐字一致）：

```sql
-- 错拼事件（append-only 日志，不参与错题本判定）
CREATE TABLE IF NOT EXISTS wrong_answer_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  word_id INTEGER NOT NULL,
  answer TEXT,
  source TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wrong_events ON wrong_answer_events(user_id, word_id);
```

- [ ] **Step 3: 应用本地迁移（供手工冒烟）**

Run: `npx wrangler d1 migrations apply dotvocab --local`
Expected: 输出 `🚣 Executed 1 command`（或提示已应用）；失败则检查 SQL 语法。

- [ ] **Step 4: 写失败的集成测试**

在 `test/api.test.ts` 末尾追加：

```ts
describe("kid: wrong-answer events (mistake book logging)", () => {
  beforeAll(async () => { await applySchema(); });

  async function countEvents() {
    const r = await env.DB.prepare("SELECT COUNT(*) as n FROM wrong_answer_events").first<{ n: number }>();
    return r?.n ?? 0;
  }

  it("correct=false records an event with answer + source; correct=true records nothing", async () => {
    const before = await countEvents();
    const wid = await seedWord("evt_wrong", "事甲");
    const res = await SELF.fetch("https://example.com/api/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: 1, word_id: wid, correct: false, source: "daily", answer: "evt_rong" }),
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT user_id, word_id, answer, source FROM wrong_answer_events ORDER BY id DESC LIMIT 1"
    ).first<any>();
    expect(row?.user_id).toBe(1);
    expect(row?.word_id).toBe(wid);
    expect(row?.answer).toBe("evt_rong");
    expect(row?.source).toBe("daily");

    const wid2 = await seedWord("evt_right", "事乙");
    const res2 = await SELF.fetch("https://example.com/api/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: 1, word_id: wid2, correct: true, source: "daily", answer: "ignored" }),
    });
    expect(res2.status).toBe(200);
    expect(await countEvents()).toBe(before + 1); // 只有答错那一条
  });

  it("legacy payload without source/answer stores NULLs", async () => {
    const wid = await seedWord("evt_legacy", "事丙");
    const res = await SELF.fetch("https://example.com/api/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: 1, word_id: wid, correct: false }),
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT answer, source FROM wrong_answer_events ORDER BY id DESC LIMIT 1"
    ).first<any>();
    expect(row?.answer).toBeNull();
    expect(row?.source).toBeNull();
  });

  it("invalid source stored as NULL; overlong answer truncated to 100 chars", async () => {
    const wid = await seedWord("evt_edge", "事丁");
    const long = "a".repeat(150);
    await SELF.fetch("https://example.com/api/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: 1, word_id: wid, correct: false, source: "cheat", answer: long }),
    });
    const row = await env.DB.prepare(
      "SELECT answer, source FROM wrong_answer_events ORDER BY id DESC LIMIT 1"
    ).first<any>();
    expect(row?.source).toBeNull();
    expect((row?.answer as string)?.length).toBe(100);
  });
});
```

- [ ] **Step 5: 运行测试确认失败**

Run: `npx vitest run test/api.test.ts -t "wrong-answer events"`
Expected: FAIL（事件表无行写入，`row` 为 null / count 不变）。

- [ ] **Step 6: 实现 /review 事件写入**

`src/kid.ts` 的 `POST /review`：

6a. 请求体类型改为：

```ts
const body = await c.req.json<{ user_id: number; word_id: number; correct: boolean; source?: string; answer?: string }>();
```

6b. 在 `const stats = await applyReviewStats(...)` 之后、`return c.json(...)` 之前插入：

```ts
  // 错拼事件：append-only 日志，失败只记日志，绝不影响 /review 返回
  if (body.correct === false) {
    try {
      const source = ["daily", "unit", "mistake"].includes(body.source ?? "") ? body.source! : null;
      const answer = typeof body.answer === "string" ? body.answer.slice(0, 100) : null;
      await c.env.DB.prepare(
        "INSERT INTO wrong_answer_events (user_id, word_id, answer, source, created_at) VALUES (?,?,?,?,?)"
      ).bind(body.user_id, body.word_id, answer, source, now).run();
    } catch (e) {
      console.log("wrong_answer_events insert failed", e);
    }
  }
```

- [ ] **Step 7: 运行测试确认通过**

Run: `npx vitest run test/api.test.ts`
Expected: 全部 PASS（含既有用例——`correct: false` 旧用例现在也会写事件，不影响其断言）。

- [ ] **Step 8: 提交**

```bash
git add migrations/0002_mistake_events.sql test/schema.ts src/kid.ts test/api.test.ts
git commit -m "feat(mistake): /review 答错记录错拼事件表(append-only), 兼容旧客户端"
```

---

## Task 2: `/session/mistakes` 队列 + `/home` 的 `mistake_count`

**Files:**
- Modify: `src/kid.ts`（新增 route + `/home` 扩展）
- Test: `test/api.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `wrong_answer_events` 表（本任务不直接用它，判定纯派生自 `user_word_state`）。
- Produces（Task 6 依赖）：
  - `GET /api/session/mistakes?user_id=` → `[{id, term, pos, meaning_cn, example_en, example_cn, reps, interval_days, due_at, lapses}]`（与 `/session/due` 同形态，随机序）
  - `GET /api/home` 响应新增 `mistake_count: number`

- [ ] **Step 1: 写失败的集成测试**

在 `test/api.test.ts` 末尾追加：

```ts
describe("kid: mistake book derived queue + home count", () => {
  beforeAll(async () => { await applySchema(); });
  const h = { "content-type": "application/json" };
  const post = (url: string, body: unknown) =>
    SELF.fetch("https://example.com" + url, { method: "POST", headers: h, body: JSON.stringify(body) });

  it("wrong word enters book; 2 consecutive corrects graduate it; re-wrong re-enters", async () => {
    const wid = await seedWord("mb_word", "册甲");
    const inBook = async () => {
      const res = await SELF.fetch("https://example.com/api/session/mistakes?user_id=1");
      return (await json(res) as any[]).some((w) => w.term === "mb_word");
    };
    expect(await inBook()).toBe(false); // 全新词不在册
    await post("/api/review", { user_id: 1, word_id: wid, correct: false });
    expect(await inBook()).toBe(true);  // 错一次进本
    await post("/api/review", { user_id: 1, word_id: wid, correct: true });
    expect(await inBook()).toBe(true);  // 只对一次仍在册
    await post("/api/review", { user_id: 1, word_id: wid, correct: true });
    expect(await inBook()).toBe(false); // 连对 2 次毕业
    await post("/api/review", { user_id: 1, word_id: wid, correct: false });
    expect(await inBook()).toBe(true);  // 毕业后再错重新进本
  });

  it("home mistake_count tracks book size", async () => {
    const wid = await seedWord("mb_count", "册乙");
    const home = async () =>
      (await json(await SELF.fetch("https://example.com/api/home?user_id=1")) as any).mistake_count;
    const before = await home();
    await post("/api/review", { user_id: 1, word_id: wid, correct: false });
    expect(await home()).toBe(before + 1);
    await post("/api/review", { user_id: 1, word_id: wid, correct: true });
    await post("/api/review", { user_id: 1, word_id: wid, correct: true });
    expect(await home()).toBe(before); // 毕业, 计数回落
  });

  it("empty book returns []; missing user_id => 400", async () => {
    const res = await SELF.fetch("https://example.com/api/session/mistakes?user_id=910");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual([]);
    const bad = await SELF.fetch("https://example.com/api/session/mistakes");
    expect(bad.status).toBe(400);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/api.test.ts -t "mistake book derived"`
Expected: FAIL（404——`/api/session/mistakes` 路由不存在；`mistake_count` undefined）。

- [ ] **Step 3: 实现两个端点**

3a. `src/kid.ts` 的 `kid.get("/session/due", ...)` 之后新增：

```ts
kid.get("/session/mistakes", async (c) => {
  const userId = Number(c.req.query("user_id"));
  if (!userId) return c.json({ error: "缺少 user_id" }, 400);
  // 错题本成员纯派生：错过(lapses>0)且毕业后连对不足 2 次(reps<2)
  const { results } = await c.env.DB.prepare(
    `SELECT w.id, w.term, w.pos, w.meaning_cn, w.example_en, w.example_cn,
            s.reps, s.interval_days, s.due_at, s.lapses
     FROM user_word_state s JOIN words w ON w.id = s.word_id
     WHERE s.user_id = ? AND s.lapses > 0 AND s.reps < 2
     ORDER BY RANDOM()`
  ).bind(userId).all();
  return c.json(results);
});
```

3b. `kid.get("/home", ...)` 中，`due` 查询之后加：

```ts
  const mistakes = await c.env.DB.prepare(
    "SELECT COUNT(*) as n FROM user_word_state WHERE user_id=? AND lapses > 0 AND reps < 2"
  ).bind(userId).first<{ n: number }>();
```

返回对象加一个字段（`due_count` 之后）：

```ts
    mistake_count: mistakes?.n ?? 0,
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/api.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/kid.ts test/api.test.ts
git commit -m "feat(mistake): 派生错题队列 /session/mistakes + home 错题计数"
```

---

## Task 3: 管理端级联清理事件表

**Files:**
- Modify: `src/admin.ts:116-131`（deep reset）、`src/admin.ts:149-161`（删词）
- Test: `test/api.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `wrong_answer_events` 表。
- Produces: `POST /api/admin/reset-progress`（deep）响应新增 `events_deleted: number`。

- [ ] **Step 1: 写失败的集成测试**

在 `test/api.test.ts` 末尾追加：

```ts
describe("admin: wrong_answer_events cascade cleanup", () => {
  beforeAll(async () => { await applySchema(); });
  const h = { "content-type": "application/json" };

  async function seedEvent(userId: number, wordId: number) {
    await env.DB.prepare(
      "INSERT INTO wrong_answer_events (user_id, word_id, answer, source, created_at) VALUES (?,?,?,NULL,1)"
    ).bind(userId, wordId, "x").run();
  }

  it("deleting a word removes its events too", async () => {
    const wid = await seedWord("cascade_evt", "级事");
    await seedEvent(1, wid);
    const res = await SELF.fetch(`https://example.com/api/admin/words/${wid}`, {
      method: "DELETE", headers: { "x-admin-token": adminToken },
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT id FROM wrong_answer_events WHERE word_id=?").bind(wid).first();
    expect(row).toBeNull();
  });

  it("deep unit-scoped reset deletes events in scope and reports events_deleted", async () => {
    const ua = await env.DB.prepare("INSERT INTO units (book, unit) VALUES ('级联书','CU1') RETURNING id").first<{ id: number }>();
    const ub = await env.DB.prepare("INSERT INTO units (book, unit) VALUES ('级联书','CU2') RETURNING id").first<{ id: number }>();
    const w1 = await seedWord("cascade_u1", "级甲");
    const w2 = await seedWord("cascade_u2", "级乙");
    await env.DB.prepare("INSERT INTO unit_words (unit_id, word_id) VALUES (?,?),(?,?)").bind(ua!.id, w1, ub!.id, w2).run();
    await seedEvent(920, w1);
    await seedEvent(920, w2);

    const res = await SELF.fetch("https://example.com/api/admin/reset-progress", {
      method: "POST", headers: { ...h, "x-admin-token": adminToken },
      body: JSON.stringify({ scope: "unit", unit_id: ua!.id, user_ids: [920], deep: true }),
    });
    const data: any = await json(res);
    expect(res.status).toBe(200);
    expect(data.events_deleted).toBe(1);
    const left = await env.DB.prepare(
      "SELECT word_id FROM wrong_answer_events WHERE user_id=920"
    ).all<{ word_id: number }>();
    expect(left.results.map((r) => r.word_id)).toEqual([w2]); // 范围外保留
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/api.test.ts -t "cascade"`
Expected: FAIL（删词后事件残留；`events_deleted` undefined）。

- [ ] **Step 3: 实现级联**

3a. `src/admin.ts` 的 `admin.delete("/words/:id")` batch 数组，在 `DELETE FROM unit_words...` 之后、`DELETE FROM words...` 之前插入一行：

```ts
    db.prepare("DELETE FROM wrong_answer_events WHERE word_id=?").bind(id),
```

3b. `admin.post("/reset-progress")` 的 `if (deep)` 块，在 `user_word_state` 删除之后、`user_stats` 更新之前插入：

```ts
    stmts.push(db.prepare(
      `DELETE FROM wrong_answer_events WHERE user_id IN (${placeholders})${stateWordFilter}`
    ).bind(...user_ids, ...stateExtraArgs));
```

响应改为（batch 索引：0 覆盖、1 state、2 events、3 stats）：

```ts
  return c.json({
    ok: true,
    deleted: results[0].meta.changes ?? 0,
    state_deleted: deep ? (results[1].meta.changes ?? 0) : 0,
    events_deleted: deep ? (results[2].meta.changes ?? 0) : 0,
    stats_reset: deep ? (results[3].meta.changes ?? 0) : 0,
  });
```

- [ ] **Step 4: 运行测试确认通过（含既有 reset-progress 用例）**

Run: `npx vitest run test/api.test.ts`
Expected: 全部 PASS（既有用例不断言响应全等，新增字段不破坏）。

- [ ] **Step 5: 提交**

```bash
git add src/admin.ts test/api.test.ts
git commit -m "feat(mistake): 删词与深度重置级联清理错拼事件, 响应加 events_deleted"
```

---

## Task 4: `recordAnswer` 透传 `source`/`answer` + `onResult` 回调

**Files:**
- Modify: `public/review-client.js`
- Test: `test/review-client.test.ts`

**Interfaces:**
- Produces（Task 6 依赖）：

```ts
recordAnswer(opts: {
  post: (path: string, body: Record<string, unknown>) => Promise<any>;
  userId: number; wordId: number; correct: boolean; unitId: number | null;
  source?: string;            // 'daily' | 'unit' | 'mistake'
  answer?: string | null;     // 答错时的拼写原文
  onResult?: (result: any | null) => void;  // /review 成功→其 JSON, 失败→null
  onError?: () => void;
}): void
```

`/review` 请求体变为：`{ user_id, word_id, correct, source: source ?? null, answer: correct ? null : (answer ?? null), }`（`/cover` 请求体不变）。

- [ ] **Step 1: 写失败的单元测试**

先给文件顶部 `makePost` 的 `/review` 成功路径带上返回值（`/cover` 仍 `resolve()`），让 `onResult` 成功断言可写——把 `resolve()` 的一处改为：

```ts
        resolve: () => (path === "/review" && opts.failReview) || (path === "/cover" && opts.failCover)
          ? reject(new Error("net"))
          : resolve(path === "/review" ? { state: { reps: 1 } } : undefined),
```

（即 `makePost` 内 `resolve` 处改为上面这行；`post` 函数签名 `Promise<any>`。）

然后在 `test/review-client.test.ts` 末尾追加：

```ts
describe("recordAnswer: source/answer passthrough + onResult", () => {
  it("sends source and answer (wrong) in /review body; correct sends answer null", () => {
    const f = makePost();
    recordAnswer({ ...base, correct: false, source: "mistake", answer: "aple", post: f.post, onError: () => {} });
    f.releaseAll();
    expect(f.calls[0].body).toEqual({
      user_id: 7, word_id: 42, correct: false, source: "mistake", answer: "aple",
    });
    const ok = makePost();
    recordAnswer({ ...base, source: "daily", answer: "whatever", post: ok.post, onError: () => {} });
    ok.releaseAll();
    expect(ok.calls[0].body.answer).toBeNull(); // 答对不带拼写
  });

  it("onResult receives /review JSON on success, null on /review failure", async () => {
    const f = makePost();
    let got: unknown = "unset";
    recordAnswer({ ...base, post: f.post, onError: () => {}, onResult: (r) => { got = r; } });
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toBe("unset"); // 尚未 release, 回调不该发生(非阻塞)
    f.releaseAll();
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual({ state: { reps: 1 } });
    const bad = makePost({ failReview: true });
    let gotNull: unknown = "unset";
    recordAnswer({ ...base, post: bad.post, onError: () => {}, onResult: (r) => { gotNull = r; } });
    bad.releaseAll();
    await new Promise((r) => setTimeout(r, 0));
    expect(gotNull).toBeNull(); // 失败 → null
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/review-client.test.ts`
Expected: FAIL（body 里没有 `source`/`answer` 字段；`onResult` 从不被调用）。

- [ ] **Step 3: 实现**

`public/review-client.js` 整体替换为：

```js
// ---------- 乐观上报：答案判定不等人 ----------
// 提交瞬间 UI 已本地判定并给出反馈；/review 与 /cover 在后台并行发出，
// 一滴不阻塞学习流程。失败只做非阻塞提示（onError）：进度没存上，
// 下次这个单词还会出现，对孩子无损——绝不让网络问题打断学习节奏。
// source/answer 供错题本事件日志使用；onResult 在 /review 结束后回调
// （成功→响应 JSON，含最新 SRS state；失败→null），供会话小结统计毕业数。

export function recordAnswer(opts) {
  const { post, userId, wordId, correct, unitId, source, answer, onError, onResult } = opts;
  const requests = [
    post("/review", {
      user_id: userId, word_id: wordId, correct,
      source: source ?? null,
      answer: correct ? null : (answer ?? null),
    }),
  ];
  // 单元覆盖只在答对时推进：答错的词不算"学会"，下次学新词时还会出现
  if (unitId && correct) {
    requests.push(post("/cover", { user_id: userId, unit_id: unitId, word_id: wordId }));
  }
  let failed = false;
  Promise.allSettled(requests).then((results) => {
    for (const r of results) {
      if (r.status === "rejected") failed = true;
    }
    if (onResult) onResult(results[0].status === "fulfilled" ? results[0].value : null);
    if (failed && onError) onError();
  });
}
```

- [ ] **Step 4: 运行测试确认通过（含既有 5 个用例）**

Run: `npx vitest run test/review-client.test.ts`
Expected: 全部 PASS（既有用例不断言 body 全等，新增字段不破坏）。

- [ ] **Step 5: 提交**

```bash
git add public/review-client.js test/review-client.test.ts
git commit -m "feat(mistake): recordAnswer 透传 source/answer 并新增 onResult 回调"
```

---

## Task 5: 纯函数 `countGraduated` + 单测

**Files:**
- Create: `public/mistake-helpers.js`
- Test: `test/mistake-helpers.test.ts`

**Interfaces:**
- Produces（Task 6 依赖）：
  - `countGraduated(queue: Array<{id: number, lapses: number, reps: number}>, finalStates: Record<number, {reps: number}>): number`
  - 语义：会话开始时在册（`lapses>0 && reps<2`）且会话内最后一次成功上报的 state `reps>=2` 的词数。上报失败的词不在 `finalStates` 里 → 不计。

- [ ] **Step 1: 写失败的单元测试**

创建 `test/mistake-helpers.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { countGraduated } from "../public/mistake-helpers.js";

const q = (id: number, lapses: number, reps: number) => ({ id, lapses, reps });

describe("countGraduated", () => {
  it("counts words in-book at start whose final reps >= 2", () => {
    const queue = [q(1, 2, 0), q(2, 1, 1), q(3, 0, 0)]; // 3 是新词, 不算
    const finals = { 1: { reps: 2 }, 2: { reps: 2 }, 3: { reps: 2 } };
    expect(countGraduated(queue, finals)).toBe(2);
  });

  it("final reps 1 (not graduated) does not count", () => {
    const queue = [q(1, 1, 0)];
    expect(countGraduated(queue, { 1: { reps: 1 } })).toBe(0);
  });

  it("words with no successful report (net failure) do not count", () => {
    const queue = [q(1, 1, 0), q(2, 1, 0)];
    expect(countGraduated(queue, { 2: { reps: 3 } })).toBe(1);
  });

  it("empty queue / empty finals => 0", () => {
    expect(countGraduated([], {})).toBe(0);
    expect(countGraduated([q(1, 1, 0)], {})).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/mistake-helpers.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

创建 `public/mistake-helpers.js`：

```js
// ---------- 错题毕业统计（纯函数, 无 DOM, 供 vitest 直接测试） ----------
// 毕业口径: 会话开始时在错题本里(lapses>0 && reps<2, 队列快照即开赛时点)
// 且会话内最后一次成功上报的 state.reps >= 2(连对 2 次毕业)。
// 上报失败的词不在 finalStates 里, 天然不计数(非阻塞降级)。

export function countGraduated(queue, finalStates) {
  let n = 0;
  for (const w of queue) {
    if (w.lapses > 0 && w.reps < 2) {
      const st = finalStates[w.id];
      if (st && st.reps >= 2) n++;
    }
  }
  return n;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/mistake-helpers.test.ts`
Expected: 4 个用例全 PASS。

- [ ] **Step 5: 提交**

```bash
git add public/mistake-helpers.js test/mistake-helpers.test.ts
git commit -m "feat(mistake): 会话毕业统计纯函数 countGraduated (TDD)"
```

---

## Task 6: 前端接线（首页卡片 / mistake 会话 / source / 毕业小结）

**Files:**
- Modify: `public/app.js`
- Modify: `public/style.css`（末尾追加）
- 依赖：Task 2 的 API、Task 4 的 `recordAnswer`、Task 5 的 `countGraduated`

**Interfaces:**
- Consumes: `GET /api/session/mistakes`、`home.mistake_count`、`recordAnswer({source, answer, onResult})`、`countGraduated(queue, finalStates)`。

本任务是 DOM 接线，仓库对 `app.js` 无直接单测（惯例：纯逻辑抽模块，见 spell-helpers 先例），以**全量测试 + 手工冒烟**验证。

- [ ] **Step 1: app.js 顶部 import**

在 `import { recordAnswer } from "./review-client.js";` 之后加：

```js
import { countGraduated } from "./mistake-helpers.js";
```

- [ ] **Step 2: 首页错题本卡片**

`showHome()` 中，模板里 `<button class="big" id="review">...</button>` 之后加一行：

```html
    <button class="big" id="mistakes"></button>
```

`wrap.querySelector("#review").onclick = ...` 之后加：

```js
  const mb = wrap.querySelector("#mistakes");
  if (home.mistake_count > 0) {
    mb.textContent = `📒 错题本 (${home.mistake_count})`;
    mb.onclick = () => startSession({ mode: "mistake", title: "错题本" });
  } else {
    mb.textContent = "📒 错题本 · 太棒了，没有错题！";
    mb.disabled = true;
  }
```

`public/style.css` 末尾追加：

```css
.big:disabled { opacity: .55; box-shadow: none; transform: none; cursor: default; }
```

- [ ] **Step 3: 会话模式 mistake + source 接线**

`startSession({ mode, unit_id, title })` 中：

3a. 请求分支改为（`mode === "due"` 之后）：

```js
    if (mode === "due") words = await api(`/session/due?user_id=${currentUser.id}`);
    else if (mode === "mistake") words = await api(`/session/mistakes?user_id=${currentUser.id}`);
    else words = await api(`/session/unit`, { method: "POST", body: JSON.stringify({ user_id: currentUser.id, unit_id }) });
```

3b. 会话状态声明区（`const stats = { done: 0, correct: 0 };` 附近）加两行：

```js
  const source = mode === "due" ? "daily" : mode === "mistake" ? "mistake" : "unit";
  const finalStates = {}; // wordId -> 最后一次成功 /review 返回的 state（毕业统计依据）
```

3c. `spellingCard` 的 `submit()` 里 `recordAnswer({...})` 调用改为：

```js
        recordAnswer({
          post: (path, body) => api(path, { method: "POST", body: JSON.stringify(body) }),
          userId: currentUser.id,
          wordId: w.id,
          correct,
          unitId: unit_id || null,
          source,
          answer: correct ? null : ans,
          onResult: (r) => { if (r && r.state) finalStates[w.id] = r.state; },
          onError: () => showToast("😵 网络开小差了，刚才的进度可能没存上", "bad"),
        });
```

- [ ] **Step 4: 会话小结毕业行**

`finish()` 中，`const practice = ...` 之前加：

```js
    const graduated = countGraduated(words, finalStates);
```

（`words` 是会话开始拉取的原始队列快照。）小结 `<p>` 之后插入：

```js
    const gradLine = graduated > 0 ? `<p>🎓 错题毕业 x ${graduated}，太厉害了！</p>` : "";
```

模板里 `${practice}` 之前插入 `${gradLine}`。

- [ ] **Step 5: 全量测试**

Run: `npm test`
Expected: 全部 PASS（后端 + 5 个前端模块测试文件）。

- [ ] **Step 6: 手工冒烟（wrangler dev）**

Run: `npm run dev`（浏览器开 http://localhost:8787）

1. 选一个孩子 → 进任一单元 → 故意拼错一个词。
2. 返回基地：错题本卡片显示 `📒 错题本 (1)`。
3. 点卡片进入错题练习：拼错 1 次（应排到队尾再来）、然后连对 2 次。
4. 返回基地：卡片变回"太棒了，没有错题！"（disabled）。
5. 会话小结里出现"🎓 错题毕业 x 1"。
6. 验证 D1 事件落库：`npx wrangler d1 execute dotvocab --local --command "SELECT user_id, word_id, answer, source FROM wrong_answer_events ORDER BY id DESC LIMIT 5"`（answer 应是拼错原文、source 对应入口）。

- [ ] **Step 7: 提交**

```bash
git add public/app.js public/style.css
git commit -m "feat(mistake): 首页错题本卡片+错题练习会话+毕业小结, 全入口上报 source"
```

---

## 部署（用户手动执行，不在任务内）

1. `npx wrangler d1 migrations apply dotvocab --remote`
2. `npm run deploy`
3. 线上冒烟一遍 Task 6 Step 6 的流程。

## Self-Review 记录

- Spec 覆盖：§4 表/索引（Task 1）、§5 判定（Task 2 测试覆盖四行真值表）、§6 三端点+级联（Task 1/2/3）、§7 前端四点（Task 4/5/6）、§8 错误处理（Task 1 try/catch + Task 6 冒烟空本态）、§10 测试清单逐条落入 Task 1/2/3/4/5。
- 无占位符；所有代码块完整可落盘。
- 类型/命名一致性：`wrong_answer_events`、`mistake_count`、`events_deleted`、`source` 白名单三值、`countGraduated(queue, finalStates)`、`recordAnswer` 新 opts 在各任务间一致。
