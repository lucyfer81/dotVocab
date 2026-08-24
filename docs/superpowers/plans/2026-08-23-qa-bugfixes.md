# QA Bug 修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 2026-08-23 E2E 测试发现的、在"固定两个孩子"真实场景下仍然成立的缺陷（B1–B8、B12），并顺手补两处廉价加固。

**Architecture:** 全部为服务端 Hono 路由与一个纯函数解析器的局部修改，外加 admin.js 一处前端修补。核心是 `/api/review` 的 SRS 写入从"读-改-写"改为单条原子 UPSERT（与星星路径的原子性对齐），以及全线 JSON 端点的输入校验。无数据库迁移。

**Tech Stack:** Hono 4 / Cloudflare Workers D1 / vitest（@cloudflare/vitest-pool-workers，测试通过 `SELF.fetch` 打到 workerd 内实例）

**Spec:** 本文件的「附录 A：缺陷清单与两用户场景适用性」即为需求来源（E2E 测试报告结论），计划随附执行。

## Global Constraints

- 不修改数据库 schema，不新增迁移文件。
- 不改变既有 API 的成功响应结构（只新增 4xx 错误路径）。
- 既有 143 个单元测试全部保持通过（已核对：无任何测试依赖待收紧的宽松行为）。
- 每个 Task 独立可测试、独立提交，遵循 TDD：先写失败测试，再实现。
- 提交信息风格沿用仓库惯例：`fix(scope): 中文描述`。
- 测试基建约定（test/api.test.ts 已有）：`SELF.fetch("https://example.com/api/...")` 调接口；`env.DB` 直查库；`beforeAll(applySchema)`；DB 在 describe 之间不重置，断言计数类数据时先读初值再算增量。

---

### Task 1: `/api/review` 输入校验（B2 + B5 的 /review 部分）

**Files:**
- Modify: `src/kid.ts:41-47`（POST /review 开头）
- Test: `test/api.test.ts`（追加到 `kid: users + review + cover` describe）

**Interfaces:**
- Consumes: 无
- Produces: `/api/review` 新契约 —— `user_id`/`word_id` 必须为正整数，`correct` 必须为布尔值，body 必须为合法 JSON；否则 400。后续 Task 2 在此之上改写入方式。

- [ ] **Step 1: 写失败测试**

```ts
it("review rejects non-boolean correct (B2)", async () => {
  const wid = await seedWord("boolguard", "布尔");
  for (const correct of ["false", "true", 1, null]) {
    const body: Record<string, unknown> = { user_id: 1, word_id: wid };
    if (correct !== null) body.correct = correct; // null 场景=缺失字段
    const res = await SELF.fetch("https://example.com/api/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
  }
  // 确认没有任何状态被写入（错误请求不得产生 lapses）
  const row = await env.DB.prepare(
    "SELECT reps, lapses FROM user_word_state WHERE user_id=1 AND word_id=?"
  ).bind(wid).first();
  expect(row).toBeNull();
});

it("review rejects malformed JSON with 400, not 500 (B5)", async () => {
  const res = await SELF.fetch("https://example.com/api/review", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{bad json",
  });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/api.test.ts -t "review rejects"`
Expected: FAIL（当前返回 200 或 500）

- [ ] **Step 3: 实现**

`src/kid.ts` POST /review 开头替换为：

```ts
kid.post("/review", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "请求体不是合法 JSON" }, 400);
  if (!Number.isInteger(body.user_id) || body.user_id <= 0 ||
      !Number.isInteger(body.word_id) || body.word_id <= 0) {
    return c.json({ error: "参数不完整" }, 400);
  }
  if (typeof body.correct !== "boolean") return c.json({ error: "correct 必须为布尔值" }, 400);
  // ……refs 存在性检查及其后逻辑不变
```

（原 `c.req.json<{...}>()` 泛型标注去掉，后面用到字段处保持 `body.xxx` 访问。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/api.test.ts`
Expected: PASS（含全部既有用例）

- [ ] **Step 5: 提交**

```bash
git add src/kid.ts test/api.test.ts
git commit -m "fix(api): /review 校验 correct 必须为布尔值、id 为正整数，坏 JSON 返回 400"
```

---

### Task 2: `/api/review` SRS 原子化（B1，高危）

**Files:**
- Modify: `src/kid.ts`（POST /review 中 SELECT prev → updateSrs → UPSERT 的三段，替换为单条 UPSERT+RETURNING）
- Test: `test/api.test.ts`

**Interfaces:**
- Consumes: `updateSrs`、`emptyState`（src/srs.ts，签名不变，仅用于首插路径计算）；Task 1 的校验。
- Produces: 响应中 `state` 来自数据库 RETURNING 行（并发下也是权威值）；`updateSrs` 纯函数及其单元测试不动。

- [ ] **Step 1: 写失败测试（并发不丢更新）**

```ts
it("concurrent correct reviews never lose SRS updates (B1)", async () => {
  const wid = await seedWord("raceword", "竞速");
  const starsBefore = (await env.DB.prepare(
    "SELECT stars FROM user_stats WHERE user_id=2"
  ).first<{ stars: number }>())?.stars ?? 0;

  const responses = await Promise.all(Array.from({ length: 6 }, () =>
    SELF.fetch("https://example.com/api/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: 2, word_id: wid, correct: true }),
    })));
  expect(responses.every((r) => r.status === 200)).toBe(true);

  const row = await env.DB.prepare(
    "SELECT reps FROM user_word_state WHERE user_id=2 AND word_id=?"
  ).bind(wid).first<{ reps: number }>();
  expect(row?.reps).toBe(6); // 修复前并发下 reps < 6 而 stars = +6

  const starsAfter = (await env.DB.prepare(
    "SELECT stars FROM user_stats WHERE user_id=2"
  ).first<{ stars: number }>())?.stars ?? 0;
  expect(starsAfter - starsBefore).toBe(6);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/api.test.ts -t "concurrent correct"`
Expected: FAIL（reps < 6，workers pool 内 await 交错可复现；若本机未复现仍保留用例作为不变量守护）

- [ ] **Step 3: 实现（单条原子 UPSERT）**

`src/kid.ts` 顶部（TIME_ZONE 常量之后）加 SQL 片段常量：

```ts
// INTERVALS_DAYS = [0,1,2,4,8,16,30,60] 的 SQL 等价物。
// idx = max(0, min(旧reps+1, 7) - (旧lapses>0 ? 1 : 0))；与 updateSrs 的正确分支一致。
const INTERVAL_CASE = `CASE MAX(MIN(user_word_state.reps + 1, 7) - (user_word_state.lapses > 0), 0)
  WHEN 0 THEN 0 WHEN 1 THEN 1 WHEN 2 THEN 2 WHEN 3 THEN 4
  WHEN 4 THEN 8 WHEN 5 THEN 16 WHEN 6 THEN 30 ELSE 60 END`;
```

POST /review 中删除 `const prev = ...` 三段（SELECT prev / updateSrs(prev??empty) / INSERT..ON CONFLICT..bind），替换为：

```ts
  const now = Date.now();
  // 首插路径的值用纯函数算（空状态起转）；冲突路径的转移在 SQL 内原子完成，
  // 杜绝读-改-写在并发（同账号双设备/双开标签）下丢更新。RETURNING 行即权威状态。
  const first = updateSrs(emptyState(now), body.correct, now);
  const row = await c.env.DB.prepare(
    `INSERT INTO user_word_state (user_id, word_id, reps, interval_days, due_at, lapses, last_reviewed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(user_id, word_id) DO UPDATE SET
       reps = CASE WHEN ?8 THEN user_word_state.reps + 1 ELSE 0 END,
       interval_days = CASE WHEN ?8 THEN ${INTERVAL_CASE} ELSE 0 END,
       due_at = CASE WHEN ?8 THEN ?9 + (${INTERVAL_CASE}) * 86400000 ELSE ?9 END,
       lapses = CASE WHEN ?8 THEN user_word_state.lapses ELSE user_word_state.lapses + 1 END,
       last_reviewed_at = ?9
     RETURNING reps, interval_days, due_at, lapses, last_reviewed_at`
  ).bind(
    body.user_id, body.word_id,
    first.reps, first.interval_days, first.due_at, first.lapses, first.last_reviewed_at,
    body.correct ? 1 : 0, now
  ).first<SrsState>();
  const state = row ?? first;
```

后续 `return c.json({ state, stars_awarded: ..., ... })` 不变（state 现为权威行）。

- [ ] **Step 4: 全量回归**

Run: `npx vitest run`
Expected: 全部 PASS（既有 srs/api 用例锁定了单线程语义等价）

- [ ] **Step 5: 提交**

```bash
git add src/kid.ts test/api.test.ts
git commit -m "fix(api): /review SRS 状态改单条原子 UPSERT+RETURNING，并发不再丢更新"
```

---

### Task 3: 全线 JSON 端点 parse 守卫 + PUT words 校验（B5、B10）

**Files:**
- Create: `src/http.ts`
- Modify: `src/kid.ts`（/cover、/session/unit），`src/admin.ts`（POST /units、/import、/reset-progress、PUT /words/:id）
- Test: `test/api.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `parseJsonBody<T>(c): Promise<T | null>`（src/http.ts 导出，后续 Task 6/7 也用它）；PUT /words/:id 新契约：meaning_cn 必填非空字符串，pos/example_* 可 null/字符串，id 不存在或无行更新 → 404。

- [ ] **Step 1: 写失败测试**

```ts
describe("json body guard (B5)", () => {
  beforeAll(async () => { await applySchema(); });
  const endpoints = [
    "/api/cover", "/api/session/unit", "/api/admin/units",
    "/api/admin/import", "/api/admin/reset-progress",
  ];
  for (const ep of endpoints) {
    it(`POST ${ep} rejects malformed JSON with 400`, async () => {
      const res = await SELF.fetch("https://example.com" + ep, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": adminToken },
        body: "not-json",
      });
      expect(res.status).toBe(400);
    });
  }

  it("PUT /api/admin/words/:id rejects missing meaning_cn with 400", async () => {
    const wid = await seedWord("putguard", "守");
    const res = await SELF.fetch(`https://example.com/api/admin/words/${wid}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ pos: "n" }),
    });
    expect(res.status).toBe(400);
    // 原数据未被破坏
    const row = await env.DB.prepare("SELECT meaning_cn FROM words WHERE id=?").bind(wid).first();
    expect(row?.meaning_cn).toBe("守");
  });

  it("PUT /api/admin/words/:id returns 404 for nonexistent word (B10)", async () => {
    const res = await SELF.fetch("https://example.com/api/admin/words/424242", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ meaning_cn: "x", pos: null, example_en: null, example_cn: null }),
    });
    expect(res.status).toBe(404);
  });

  it("PUT /api/admin/words/:id rejects non-integer id with 400", async () => {
    const res = await SELF.fetch("https://example.com/api/admin/words/abc", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ meaning_cn: "x" }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/api.test.ts -t "json body guard"`
Expected: FAIL（当前为 500 或 200）

- [ ] **Step 3: 实现**

创建 `src/http.ts`：

```ts
import type { Context } from "hono";

// 统一的 JSON body 读取：解析失败返回 null（调用方回 400），
// 杜绝 c.req.json() 抛异常把坏请求变成 500。
export async function parseJsonBody<T>(c: Context): Promise<T | null> {
  try {
    return await c.req.json<T>();
  } catch {
    return null;
  }
}
```

各端点开头（kid.ts 的 /cover、/session/unit；admin.ts 的 POST /units、/import、/reset-progress）把
`const body = await c.req.json<...>();` 替换为：

```ts
import { parseJsonBody } from "./http"; // kid.ts；admin.ts 同样引入
// ...
const body = await parseJsonBody<{ /* 原泛型照抄 */ }>(c);
if (!body) return c.json({ error: "请求体不是合法 JSON" }, 400);
```

admin.ts 的 PUT /words/:id 整体替换为：

```ts
admin.put("/words/:id", async (c) => {
  const body = await parseJsonBody<{ pos: string | null; meaning_cn: string; example_en: string | null; example_cn: string | null }>(c);
  if (!body) return c.json({ error: "请求体不是合法 JSON" }, 400);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "id 不合法" }, 400);
  if (typeof body.meaning_cn !== "string" || !body.meaning_cn.trim()) {
    return c.json({ error: "缺少 meaning_cn" }, 400);
  }
  for (const k of ["pos", "example_en", "example_cn"] as const) {
    if (body[k] != null && typeof body[k] !== "string") return c.json({ error: `${k} 不合法` }, 400);
  }
  const updated = await c.env.DB.prepare(
    "UPDATE words SET pos=?, meaning_cn=?, example_en=?, example_cn=? WHERE id=? RETURNING id"
  ).bind(body.pos ?? null, body.meaning_cn, body.example_en ?? null, body.example_cn ?? null, id)
    .first<{ id: number }>();
  if (!updated) return c.json({ error: "单词不存在" }, 404);
  return c.json({ ok: true });
});
```

- [ ] **Step 4: 跑全量**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/http.ts src/kid.ts src/admin.ts test/api.test.ts
git commit -m "fix(api): JSON 端点统一 400 守卫；PUT words 校验必填字段并不存在返回 404"
```

---

### Task 4: `/api/*` 未知路径返回 JSON 404（B4）

**Files:**
- Modify: `src/index.ts`（tts 路由之后、ASSETS 兜底之前）
- Test: `test/api.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `GET/POST /api/<未知路径或方法不匹配>` → `404 {"error":"not_found"}`（静态页兜底不再吃掉 /api）。

- [ ] **Step 1: 写失败测试**

```ts
describe("api 404 fallback (B4)", () => {
  beforeAll(async () => { await applySchema(); });
  it("unknown /api path returns JSON 404, not SPA html", async () => {
    const res = await SELF.fetch("https://example.com/api/nonexistent");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await json(res)).toEqual({ error: "not_found" });
  });
  it("method mismatch returns JSON 404", async () => {
    const res = await SELF.fetch("https://example.com/api/review");
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "not_found" });
  });
  it("trailing slash does not fall through to SPA", async () => {
    const res = await SELF.fetch("https://example.com/api/users/");
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/api.test.ts -t "api 404"`
Expected: FAIL（当前 200 + HTML）

- [ ] **Step 3: 实现**

`src/index.ts` 在 `app.route("/api", tts);` 与 ASSETS 兜底之间插入：

```ts
// API 空间内的未知路径/方法统一 JSON 404：不能漏给 SPA 兜底吃掉（会变 200 HTML）。
app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));
```

- [ ] **Step 4: 跑全量**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/index.ts test/api.test.ts
git commit -m "fix(api): /api/* 未知路径与方法不匹配返回 JSON 404 而非 SPA HTML 200"
```

---

### Task 5: CSV 引号字段解析（B3，导入数据损坏）

**Files:**
- Modify: `src/csv.ts`（splitFields 重写）
- Test: `test/csv.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `parseWordCsv` 签名与行为不变；新增能力——双引号包裹字段内可含分隔符，`""` 转义为 `"`；分隔符嗅探忽略引号内的 tab。

- [ ] **Step 1: 写失败测试**

```ts
it("parses quoted fields containing commas (B3)", () => {
  const { rows, errors } = parseWordCsv('orange,"橙子, 柑橘",n,I like orange juice.,我喜欢橙汁。');
  expect(errors).toEqual([]);
  expect(rows[0]).toEqual({
    term: "orange", meaning_cn: "橙子, 柑橘", pos: "n",
    example_en: "I like orange juice.", example_cn: "我喜欢橙汁。",
  });
});

it("parses escaped double quotes inside quoted fields", () => {
  const { rows } = parseWordCsv('word,"He said ""hi""",n');
  expect(rows[0].meaning_cn).toBe('He said "hi"');
});

it("delimiter sniff ignores tabs inside quotes", () => {
  const { rows, errors } = parseWordCsv('a,"b\tc",d');
  expect(errors).toEqual([]);
  expect(rows[0]).toEqual({ term: "a", meaning_cn: "b\tc", pos: "d", example_en: null, example_cn: null });
});

it("tab-delimited lines still work with quoted commas", () => {
  const { rows, errors } = parseWordCsv('dog\t"狗, 犬"\tn');
  expect(errors).toEqual([]);
  expect(rows[0]).toEqual({ term: "dog", meaning_cn: "狗, 犬", pos: "n", example_en: null, example_cn: null });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/csv.test.ts`
Expected: FAIL（引号内逗号被切开）

- [ ] **Step 3: 实现**

`src/csv.ts` 替换 splitFields（并新增嗅探函数）：

```ts
// 分隔符嗅探：引号外出现 tab → tab，否则逗号。
function detectDelim(line: string): string {
  let inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch === "\t") return "\t";
  }
  return ",";
}

// RFC4180 风格的单行切分：引号包裹的字段可含分隔符；"" 转义为 "。
// 容错：引号只在字段开头生效；收引号后的尾随字符原样保留。
function splitFields(line: string, delim: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"' && cur === "") {
      inQ = true;
    } else if (ch === delim) {
      fields.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur.trim());
  return fields;
}
```

`parseWordCsv` 内调用处改为 `const f = splitFields(line, detectDelim(line));`（其余逻辑不动，原先 splitFields 里的 `.replace(/^"|"$/g, "")` 删除——引号已由解析器消费）。

- [ ] **Step 4: 跑全量**

Run: `npx vitest run test/csv.test.ts && npx vitest run`
Expected: PASS（既有 7 个 csv 用例 + 新 4 个）

- [ ] **Step 5: 提交**

```bash
git add src/csv.ts test/csv.test.ts
git commit -m "fix(csv): 支持引号包裹字段内的分隔符与转义引号，修复导入静默串列"
```

---

### Task 6: units upsert 保留 sort_key + 类型校验（B7/B8 服务端）

**Files:**
- Modify: `src/admin.ts:17-26`（POST /units）
- Test: `test/api.test.ts`

**Interfaces:**
- Consumes: `parseJsonBody`（Task 3）
- Produces: POST /units 新契约 —— `sort_key` 可省略（冲突时保留旧值）、必须为整数（否则 400）；新建时省略默认 0。

- [ ] **Step 1: 写失败测试**

```ts
describe("admin units sort_key (B7/B8)", () => {
  beforeAll(async () => { await applySchema(); });
  it("re-creating an existing unit without sort_key keeps the old sort_key", async () => {
    const book = "排序书" + Date.now();
    await SELF.fetch("https://example.com/api/admin/units", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ book, unit: "U1", sort_key: 5 }),
    });
    const res = await SELF.fetch("https://example.com/api/admin/units", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ book, unit: "U1" }), // 不带 sort_key
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT sort_key FROM units WHERE book=? AND unit='U1'"
    ).bind(book).first<{ sort_key: number }>();
    expect(row?.sort_key).toBe(5); // 修复前被重置为 0
  });
  it("rejects non-integer sort_key with 400", async () => {
    const res = await SELF.fetch("https://example.com/api/admin/units", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ book: "类型书", unit: "U", sort_key: "abc" }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/api.test.ts -t "sort_key"`
Expected: FAIL（sort_key 被重置为 0 / "abc" 被 200 接受）

- [ ] **Step 3: 实现**

`src/admin.ts` POST /units 替换为：

```ts
admin.post("/units", async (c) => {
  const body = await parseJsonBody<{ book: string; unit: string; sort_key?: number }>(c);
  if (!body) return c.json({ error: "请求体不是合法 JSON" }, 400);
  if (!body.book || !body.unit) return c.json({ error: "缺少 book/unit" }, 400);
  if (body.sort_key !== undefined && !Number.isInteger(body.sort_key)) {
    return c.json({ error: "sort_key 必须为整数" }, 400);
  }
  // 省略 sort_key：新建默认 0；已存在则保留旧值（COALESCE(?4)），
  // 杜绝重复建单元把排序悄悄归零、打乱孩子端星球顺序。
  const r = await c.env.DB.prepare(
    `INSERT INTO units (book, unit, sort_key) VALUES (?1, ?2, COALESCE(?3, 0))
     ON CONFLICT(book, unit) DO UPDATE SET sort_key = COALESCE(?4, units.sort_key)
     RETURNING id`
  ).bind(body.book, body.unit, body.sort_key ?? null, body.sort_key ?? null)
    .first<{ id: number }>();
  return c.json({ id: r?.id });
});
```

（`body.sort_key` 显式传 `null` 时等同省略——前端 Task 8 保证不会传 null，服务端按省略容错。）

- [ ] **Step 4: 跑全量**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/admin.ts test/api.test.ts
git commit -m "fix(admin): 重建单元不再重置 sort_key，非整数 sort_key 返回 400"
```

---

### Task 7: import 校验单元存在（B6，孤儿关联）

**Files:**
- Modify: `src/admin.ts`（POST /import，在 parseWordCsv 之前）
- Test: `test/api.test.ts`

**Interfaces:**
- Consumes: `parseJsonBody`（Task 3）
- Produces: POST /import 对不存在的 unit_id 返回 `404 {"error":"单元不存在"}`，且不产生任何 words/unit_words 写入。

- [ ] **Step 1: 写失败测试**

```ts
it("import to nonexistent unit returns 404 and writes nothing (B6)", async () => {
  const wordsBefore = (await env.DB.prepare("SELECT COUNT(*) n FROM words").first<{ n: number }>())!.n;
  const res = await SELF.fetch("https://example.com/api/admin/import", {
    method: "POST", headers: { "content-type": "application/json", "x-admin-token": adminToken },
    body: JSON.stringify({ unit_id: 424242, csv: "ghostword,幽灵" }),
  });
  expect(res.status).toBe(404);
  const wordsAfter = (await env.DB.prepare("SELECT COUNT(*) n FROM words").first<{ n: number }>())!.n;
  expect(wordsAfter).toBe(wordsBefore);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/api.test.ts -t "nonexistent unit"`
Expected: FAIL（当前 200 且插入词）

- [ ] **Step 3: 实现**

POST /import 在 `parseWordCsv` 调用之前（类型校验之后）加：

```ts
  if (!Number.isInteger(body.unit_id) || body.unit_id <= 0 || typeof body.csv !== "string" || !body.csv) {
    return c.json({ error: "缺少 unit_id/csv" }, 400);
  }
  const unit = await c.env.DB.prepare("SELECT id FROM units WHERE id=?")
    .bind(body.unit_id).first<{ id: number }>();
  if (!unit) return c.json({ error: "单元不存在" }, 404);
```

（D1 不强制外键，存在性必须在应用层把关，否则词被静默塞进不可见单元。）

- [ ] **Step 4: 跑全量**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/admin.ts test/api.test.ts
git commit -m "fix(admin): 导入前校验单元存在，杜绝孤儿 unit_words 关联"
```

---

### Task 8: admin.js 添加单元的错误处理与 sort_key 语义（B12 + B7 前端侧）

**Files:**
- Modify: `public/admin.js:74-77`（#addunit onclick）

**Interfaces:**
- Consumes: Task 6 的服务端契约（省略 sort_key = 保留旧值；非整数 → 400）。
- Produces: 无新接口。UI 行为：空字段/非整数排序 → toast 提示；空排序不再发送 `sort_key: 0`（否则服务端语义会被"显式 0"击穿）。

- [ ] **Step 1: 手工复现（修复前基线）**

Run: `npx wrangler dev --port 8801 --persist-to /tmp/opencode/qa-t8 &`，浏览器开 `http://127.0.0.1:8801/admin` 登录后：
1. 单元名留空点「添加单元」→ 预期现象（bug）：无任何反馈；
2. 对已有单元重复添加且排序留空 → 词库首页星球顺序被打乱（服务端 Task 6 已修，此处验证 UI 侧仍显式发 0 需修）。

- [ ] **Step 2: 实现**

`public/admin.js` 的 `#addunit` onclick 替换为：

```js
  wrap.querySelector("#addunit").onclick = async () => {
    const book = wrap.querySelector("#book").value.trim();
    const unit = wrap.querySelector("#unit").value.trim();
    if (!book || !unit) { showToast("课本和单元都要填哦", "bad"); return; }
    const sortRaw = wrap.querySelector("#sort").value.trim();
    const body = { book, unit };
    if (sortRaw !== "") {
      const n = Number(sortRaw);
      if (!Number.isInteger(n)) { showToast("排序号要填整数", "bad"); return; }
      body.sort_key = n; // 留空则整个省略：服务端保留旧排序（B7 契约）
    }
    try {
      await api("/units", { method: "POST", body: JSON.stringify(body) });
      dashboard();
    } catch (e) { showToast(e.message, "bad"); }
  };
```

（`showToast` 已在文件头部 import，无需新增。）

- [ ] **Step 3: 手工验证（修复后）**

同 Step 1 场景：空字段 → toast「课本和单元都要填哦」；排序填 `abc` → toast「排序号要填整数」；重复添加已有单元且排序留空 → `GET /api/admin/units` 确认 sort_key 未变。
Run: `npx vitest run`（确认无意外破坏；admin.js 无 DOM 测试基建，验证以手工为准）

- [ ] **Step 4: 提交**

```bash
git add public/admin.js
git commit -m "fix(admin-ui): 添加单元表单校验与错误提示；排序留空不再显式发 0"
```

---

### Task 9: 廉价加固（B9：/home 未知用户 404；B14a：时序安全 token 比较）

**Files:**
- Modify: `src/kid.ts`（GET /home 开头）、`src/auth.ts`
- Test: `test/api.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `GET /api/home?user_id=<不存在>` → 404；admin 鉴权改为 SHA-256 后逐字节异或比较（非常量时间字符串比较）。

- [ ] **Step 1: 写失败测试**

```ts
describe("hardening (B9/B14a)", () => {
  beforeAll(async () => { await applySchema(); });
  it("GET /api/home returns 404 for unknown user", async () => {
    const res = await SELF.fetch("https://example.com/api/home?user_id=424242");
    expect(res.status).toBe(404);
  });
  it("admin auth still accepts correct token and rejects wrong one", async () => {
    const ok = await SELF.fetch("https://example.com/api/admin/units", { headers: { "x-admin-token": adminToken } });
    expect(ok.status).toBe(200);
    const bad = await SELF.fetch("https://example.com/api/admin/units", { headers: { "x-admin-token": "x".repeat(64) } });
    expect(bad.status).toBe(401);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/api.test.ts -t "hardening"`
Expected: home 用例 FAIL（当前 200 全零）

- [ ] **Step 3: 实现**

kid.ts GET /home，在现有 user_id 解析之后加：

```ts
  const user = await c.env.DB.prepare("SELECT id FROM users WHERE id=?").bind(userId).first();
  if (!user) return c.json({ error: "用户不存在" }, 404);
```

src/auth.ts 整体替换为：

```ts
import { createMiddleware } from "hono/factory";
import type { Env } from "./index";

async function sha256Bytes(s: string): Promise<Uint8Array> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return new Uint8Array(d);
}

export const adminAuth = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const token = c.req.header("x-admin-token") ?? "";
  if (!c.env.ADMIN_TOKEN) return c.json({ error: "未授权" }, 401);
  // 先哈希到定长再逐字节比较：避免逐字符短路比较泄露前缀信息
  const [a, b] = [await sha256Bytes(token), await sha256Bytes(c.env.ADMIN_TOKEN)];
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= a[i] ^ b[i];
  if (diff !== 0) return c.json({ error: "未授权" }, 401);
  await next();
});
```

- [ ] **Step 4: 跑全量**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/kid.ts src/auth.ts test/api.test.ts
git commit -m "fix(api): /home 未知用户返回 404；admin 口令比较改时序安全"
```

---

## 明确暂缓（不在本计划内）

| 缺陷 | 暂缓理由（两用户场景） |
|---|---|
| B11 `/cover` 不校验 word∈unit | 正常前端只会发送会话所属单元+词的组合，仅手工篡改可触发；且 seen 表 PK 按单元隔离，不污染首页 pct。如需修：`INSERT OR IGNORE INTO user_unit_word_seen SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM unit_words WHERE unit_id=? AND word_id=?)` 一条语句。 |
| B13 毕业计数与最后 /review 响应的竞态 | 纯展示层瞬时少计，不落库；修复需 review-client 返回 promise 并在 finish() 等待，改动面与收益不成比例。 |
| B14 其余（登录限流、TTS 鉴权、token 存 localStorage） | 家庭私有部署、无公网暴露的多租户威胁；TTS 是孩子端无鉴权架构的必然。留待真正公网部署前评估。 |
| LSP 对 test/*.ts 的既有类型诊断 | 编辑器噪音，vitest 正常运行；属独立技术债。 |

## 部署

全部任务合入后：`npx vitest run` 全绿 → `npx wrangler deploy`。无迁移、无环境变量变更。回归重点：用 E2E 报告中的 T22–T33（SRS/错题本流）与 T38（并发）脚本在部署环境重放。

---

## 附录 A：缺陷清单与两用户场景适用性（需求来源）

固定两个孩子的真实运行条件：无用户注册（users 表仅两条种子数据）、单家长后台、孩子可能各自持设备同时玩（不同 user_id → 不同数据行，互不竞争）、同一孩子可能双设备/双开登录同一账号（同 user_id → 竞争同一行）。

| # | 缺陷 | 两用户场景适用性 | 结论 |
|---|---|---|---|
| B1 | 并发 /review 丢 SRS 更新 | 两个孩子之间不适用（行不相交）；同一孩子双设备/双开适用，且损坏静默永久 | **修**（Task 2） |
| B2 | correct 不校验类型 | 与用户数无关；核心写入口，前端恒发布尔但旧缓存/异常客户端可破坏数据 | **修**（Task 1） |
| B3 | CSV 引号内逗号串列 | 家长导入教材 CSV，英文例句常含逗号 → 高频适用，静默损坏 | **修**（Task 5） |
| B4 | 未知 /api/* 返回 HTML 200 | 前端不触发；影响调试与监控可观测性 | **修**（Task 4，3 行） |
| B5 | 坏 JSON/缺字段 → 500 | 低频（网络损坏/旧客户端）；500 污染日志 | **修**（Task 1/3） |
| B6 | 导入到不存在单元 | 管理页用下拉框，仅旧标签页场景可触发 | **修**（Task 7，一条 SELECT） |
| B7/B8 | sort_key 重置/类型 | 家长重复建同名单元是自然操作，直接打乱孩子端关卡顺序 | **修**（Task 6+8，须前后端同改） |
| B9 | /home 未知用户 200 | 仅篡改触发 | 顺手修（Task 9） |
| B10 | PUT 不存在 id ok:true | 旧标签页场景误导家长 | 顺手修（Task 3） |
| B11 | /cover word∉unit | 仅篡改，无可见影响 | 暂缓 |
| B12 | admin.js 添加单元静默失败 | 家长空字段提交无反馈，直接体验缺陷 | **修**（Task 8） |
| B13 | 毕业计数竞态 | 展示层瞬时少计 | 暂缓 |
| B14 | 加固类 | 私有部署威胁模型下仅时序安全比较值得做 | 部分修（Task 9） |
