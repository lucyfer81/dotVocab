# 家长后台：手动重置背单词进度 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 家长后台新增「重置进度」面板，可按 单元 / 书 / 全局、对 某个孩子或两个孩子 软重置背单词进度（只清单元覆盖 `user_unit_word_seen`，保留掌握度与星星）。

**Architecture:** 后端新增单一端点 `POST /api/admin/reset-progress`，按 `scope` 构造参数化 DELETE（仅删 `user_unit_word_seen`），返回删除条数；前端在 `dashboard()` 加一块统一面板，书名/单元/孩子列表复用已 fetch 的 `/units`、`/progress`，`confirm()` 二次确认后调用端点。

**Tech Stack:** Cloudflare Workers + D1 + Hono（后端），vanilla JS（前端），vitest + @cloudflare/vitest-pool-workers（测试）。

**Spec:** `docs/superpowers/specs/2026-07-31-admin-progress-reset-design.md`

---

## 文件结构

| 文件 | 责任 | 改动 |
|---|---|---|
| `src/admin.ts` | 新增 `POST /reset-progress` 处理器：校验 + 按 scope 参数化 DELETE | 修改（+1 handler，插在 `GET /progress` 之后） |
| `public/admin.js` | `dashboard()` 内新增「重置进度」面板 HTML + 交互 JS | 修改（插在 `#prog` 与 `.admin-cols` 之间） |
| `test/api.test.ts` | 新增 `describe("admin: reset-progress")` 覆盖 7 类用例 | 修改（追加在文件末尾） |
| `public/style.css` | — | **不改**（复用 `.big` / `select` / `.muted`） |

---

## Task 1: 后端端点 `POST /api/admin/reset-progress`（TDD）

**Files:**
- Modify: `test/api.test.ts`（末尾追加测试块）
- Modify: `src/admin.ts`（`GET /progress` handler 之后，约第 78 行后）

- [ ] **Step 1: 在 `test/api.test.ts` 末尾追加失败测试**

在文件最后（第 301 行最后一个 `});` 之后）追加整个 describe 块。用哨兵 user_id `901–905` 隔离计数（这些 id 不在 `users` 表里，但 schema 无外键、端点不做 user 存在性校验，DELETE 匹配 0 行也安全），避免被其它测试累积数据污染：

```ts
describe("admin: reset-progress", () => {
  beforeAll(async () => { await applySchema(); });

  async function seedCoverage(userId: number, unitId: number, wordIds: number[]) {
    for (const wid of wordIds) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO user_unit_word_seen (user_id, unit_id, word_id, first_seen_at) VALUES (?,?,?,1)"
      ).bind(userId, unitId, wid).run();
    }
  }
  async function countCoverage(userId: number) {
    const r = await env.DB.prepare(
      "SELECT COUNT(*) as n FROM user_unit_word_seen WHERE user_id=?"
    ).bind(userId).first<{ n: number }>();
    return r?.n ?? 0;
  }

  it("rejects without token => 401", async () => {
    const res = await SELF.fetch("https://example.com/api/admin/reset-progress", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "global", user_ids: [901] }),
    });
    expect(res.status).toBe(401);
  });

  it("validates params => 400 (bad scope / unit-missing-unit_id / empty user_ids / book-missing-book)", async () => {
    const h = { "content-type": "application/json", "x-admin-token": adminToken };
    const base = "https://example.com/api/admin/reset-progress";
    const bad1 = await SELF.fetch(base, { method: "POST", headers: h, body: JSON.stringify({ scope: "weird", user_ids: [901] }) });
    expect(bad1.status).toBe(400);
    const bad2 = await SELF.fetch(base, { method: "POST", headers: h, body: JSON.stringify({ scope: "unit", user_ids: [901] }) });
    expect(bad2.status).toBe(400);
    const bad3 = await SELF.fetch(base, { method: "POST", headers: h, body: JSON.stringify({ scope: "global", user_ids: [] }) });
    expect(bad3.status).toBe(400);
    const bad4 = await SELF.fetch(base, { method: "POST", headers: h, body: JSON.stringify({ scope: "book", user_ids: [901] }) });
    expect(bad4.status).toBe(400);
  });

  it("unit scope clears only that unit's coverage; leaves state + stats + other unit", async () => {
    const ua = await env.DB.prepare("INSERT INTO units (book, unit) VALUES ('重置书','U-A') RETURNING id").first<{ id: number }>();
    const ub = await env.DB.prepare("INSERT INTO units (book, unit) VALUES ('重置书','U-B') RETURNING id").first<{ id: number }>();
    const w1 = await seedWord("rscope_a1", "甲");
    const w2 = await seedWord("rscope_a2", "乙");
    const w3 = await seedWord("rscope_b1", "丙");
    await env.DB.prepare("INSERT INTO unit_words (unit_id, word_id) VALUES (?,?),(?,?),(?,?)")
      .bind(ua!.id, w1, ua!.id, w2, ub!.id, w3).run();
    await seedCoverage(901, ua!.id, [w1, w2]);
    await seedCoverage(901, ub!.id, [w3]);
    await env.DB.prepare(
      "INSERT INTO user_word_state (user_id, word_id, reps, interval_days, due_at, lapses) VALUES (901,?,3,30,0,0)"
    ).bind(w1).run();
    await env.DB.prepare(
      "INSERT INTO user_stats (user_id, stars, streak_days, last_play_date) VALUES (901,50,7,'2026-07-31')"
    ).run();

    const res = await SELF.fetch("https://example.com/api/admin/reset-progress", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ scope: "unit", unit_id: ua!.id, user_ids: [901] }),
    });
    const data: any = await json(res);
    expect(res.status).toBe(200);
    expect(data.deleted).toBe(2);

    const aLeft = await env.DB.prepare("SELECT COUNT(*) as n FROM user_unit_word_seen WHERE user_id=901 AND unit_id=?").bind(ua!.id).first<{ n: number }>();
    expect(aLeft?.n).toBe(0);
    const bLeft = await env.DB.prepare("SELECT COUNT(*) as n FROM user_unit_word_seen WHERE user_id=901 AND unit_id=?").bind(ub!.id).first<{ n: number }>();
    expect(bLeft?.n).toBe(1);
    const st = await env.DB.prepare("SELECT reps FROM user_word_state WHERE user_id=901 AND word_id=?").bind(w1).first<{ reps: number }>();
    expect(st?.reps).toBe(3);
    const stats = await env.DB.prepare("SELECT stars FROM user_stats WHERE user_id=901").first<{ stars: number }>();
    expect(stats?.stars).toBe(50);
  });

  it("book scope clears all units in that book; other book intact", async () => {
    const u1 = await env.DB.prepare("INSERT INTO units (book, unit) VALUES ('重置书X','BX1') RETURNING id").first<{ id: number }>();
    const u2 = await env.DB.prepare("INSERT INTO units (book, unit) VALUES ('重置书X','BX2') RETURNING id").first<{ id: number }>();
    const uY = await env.DB.prepare("INSERT INTO units (book, unit) VALUES ('重置书Y','BY1') RETURNING id").first<{ id: number }>();
    const w1 = await seedWord("rbook_a", "书甲");
    const w2 = await seedWord("rbook_b", "书乙");
    const w3 = await seedWord("rbook_c", "书丙");
    await env.DB.prepare("INSERT INTO unit_words (unit_id, word_id) VALUES (?,?),(?,?),(?,?)")
      .bind(u1!.id, w1, u2!.id, w2, uY!.id, w3).run();
    await seedCoverage(902, u1!.id, [w1]);
    await seedCoverage(902, u2!.id, [w2]);
    await seedCoverage(902, uY!.id, [w3]);

    const res = await SELF.fetch("https://example.com/api/admin/reset-progress", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ scope: "book", book: "重置书X", user_ids: [902] }),
    });
    const data: any = await json(res);
    expect(res.status).toBe(200);
    expect(data.deleted).toBe(2);
    const xLeft = await env.DB.prepare("SELECT COUNT(*) as n FROM user_unit_word_seen WHERE user_id=902 AND unit_id IN (?,?)").bind(u1!.id, u2!.id).first<{ n: number }>();
    expect(xLeft?.n).toBe(0);
    const yLeft = await env.DB.prepare("SELECT COUNT(*) as n FROM user_unit_word_seen WHERE user_id=902 AND unit_id=?").bind(uY!.id).first<{ n: number }>();
    expect(yLeft?.n).toBe(1);
  });

  it("global scope clears all coverage for the user; leaves state + stats", async () => {
    const u = await env.DB.prepare("INSERT INTO units (book, unit) VALUES ('重置书G','G1') RETURNING id").first<{ id: number }>();
    const w1 = await seedWord("rglob_a", "全甲");
    const w2 = await seedWord("rglob_b", "全乙");
    await env.DB.prepare("INSERT INTO unit_words (unit_id, word_id) VALUES (?,?),(?,?)").bind(u!.id, w1, u!.id, w2).run();
    await seedCoverage(903, u!.id, [w1, w2]);
    await env.DB.prepare(
      "INSERT INTO user_word_state (user_id, word_id, reps, interval_days, due_at, lapses) VALUES (903,?,2,4,0,0)"
    ).bind(w1).run();
    await env.DB.prepare(
      "INSERT INTO user_stats (user_id, stars, streak_days, last_play_date) VALUES (903,9,2,'2026-07-31')"
    ).run();

    const res = await SELF.fetch("https://example.com/api/admin/reset-progress", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ scope: "global", user_ids: [903] }),
    });
    const data: any = await json(res);
    expect(res.status).toBe(200);
    expect(data.deleted).toBe(2);
    expect(await countCoverage(903)).toBe(0);
    const st = await env.DB.prepare("SELECT reps FROM user_word_state WHERE user_id=903 AND word_id=?").bind(w1).first<{ reps: number }>();
    expect(st?.reps).toBe(2);
    const stats = await env.DB.prepare("SELECT stars FROM user_stats WHERE user_id=903").first<{ stars: number }>();
    expect(stats?.stars).toBe(9);
  });

  it("user_ids targets only named kids (single then both); deleted counts matched rows", async () => {
    const u = await env.DB.prepare("INSERT INTO units (book, unit) VALUES ('重置书K','K1') RETURNING id").first<{ id: number }>();
    const w1 = await seedWord("rkid_a", "孩甲");
    await env.DB.prepare("INSERT INTO unit_words (unit_id, word_id) VALUES (?,?)").bind(u!.id, w1).run();
    await seedCoverage(904, u!.id, [w1]);
    await seedCoverage(905, u!.id, [w1]);

    await SELF.fetch("https://example.com/api/admin/reset-progress", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ scope: "unit", unit_id: u!.id, user_ids: [904] }),
    });
    const a = await env.DB.prepare("SELECT COUNT(*) as n FROM user_unit_word_seen WHERE user_id=904 AND unit_id=?").bind(u!.id).first<{ n: number }>();
    const b = await env.DB.prepare("SELECT COUNT(*) as n FROM user_unit_word_seen WHERE user_id=905 AND unit_id=?").bind(u!.id).first<{ n: number }>();
    expect(a?.n).toBe(0);
    expect(b?.n).toBe(1);

    const res = await SELF.fetch("https://example.com/api/admin/reset-progress", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ scope: "unit", unit_id: u!.id, user_ids: [904, 905] }),
    });
    const data: any = await json(res);
    expect(res.status).toBe(200);
    expect(data.deleted).toBe(1); // 904 已清空，只剩 905 一行
    const b2 = await env.DB.prepare("SELECT COUNT(*) as n FROM user_unit_word_seen WHERE user_id=905 AND unit_id=?").bind(u!.id).first<{ n: number }>();
    expect(b2?.n).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npm test
```
Expected: FAIL —— 新增的 `admin: reset-progress` 用例全部失败（端点尚未实现，`POST /api/admin/reset-progress` 命中静态资源兜底返回 200 HTML 或 404，`res.status`/`data.deleted` 不符）。其余既有测试仍通过。

- [ ] **Step 3: 在 `src/admin.ts` 实现端点**

在 `admin.get("/progress", …)` handler 之后（`admin.get("/words", …)` 之前）插入：

```ts
admin.post("/reset-progress", async (c) => {
  const body = await c.req.json<{ scope: string; unit_id?: number; book?: string; user_ids: number[] }>();
  const user_ids = body.user_ids;
  if (!Array.isArray(user_ids) || user_ids.length === 0 ||
      !user_ids.every((n) => Number.isInteger(n) && n > 0)) {
    return c.json({ error: "user_ids 不合法" }, 400);
  }
  const placeholders = user_ids.map(() => "?").join(",");
  if (body.scope === "unit") {
    if (!Number.isInteger(body.unit_id) || (body.unit_id as number) <= 0) return c.json({ error: "缺少 unit_id" }, 400);
    const r = await c.env.DB.prepare(
      `DELETE FROM user_unit_word_seen WHERE user_id IN (${placeholders}) AND unit_id = ?`
    ).bind(...user_ids, body.unit_id).run();
    return c.json({ ok: true, deleted: r.meta.changes ?? 0 });
  }
  if (body.scope === "book") {
    if (!body.book || !body.book.trim()) return c.json({ error: "缺少 book" }, 400);
    const r = await c.env.DB.prepare(
      `DELETE FROM user_unit_word_seen WHERE user_id IN (${placeholders}) AND unit_id IN (SELECT id FROM units WHERE book = ?)`
    ).bind(...user_ids, body.book).run();
    return c.json({ ok: true, deleted: r.meta.changes ?? 0 });
  }
  if (body.scope === "global") {
    const r = await c.env.DB.prepare(
      `DELETE FROM user_unit_word_seen WHERE user_id IN (${placeholders})`
    ).bind(...user_ids).run();
    return c.json({ ok: true, deleted: r.meta.changes ?? 0 });
  }
  return c.json({ error: "scope 不合法" }, 400);
});
```

说明：`placeholders` 仅由 `?` 组成（`user_ids` 已校验为正整数数组），所有值经 `.bind(...)` 参数化绑定，杜绝 SQL 注入；`user_word_state` / `user_stats` 全程不触碰。

- [ ] **Step 4: 运行测试，确认通过**

```bash
npm test
```
Expected: PASS —— 全部用例（含新增 6 个）通过。

- [ ] **Step 5: 提交**

```bash
git add src/admin.ts test/api.test.ts
git commit -m "feat(admin): POST /reset-progress 软重置单元覆盖进度"
```

---

## Task 2: 前端「重置进度」面板

**Files:**
- Modify: `public/admin.js`（`dashboard()` 内）

> 前端无自动化测试（项目既有约定：`admin.js` 不含测试）。以端点单测 + 手动冒烟作为验证门。

- [ ] **Step 1: 在 `dashboard()` 的 `wrap` 模板里插入面板 HTML**

把这段：
```js
    <h2>进度</h2><div id="prog"></div>
    <div class="admin-cols">
```
改成：
```js
    <h2>进度</h2><div id="prog"></div>
    <h2>重置进度</h2>
    <div id="reset">
      <select id="r_scope"><option value="unit">按单元</option><option value="book">按课本</option><option value="global">全局</option></select>
      <select id="r_target"></select>
      <select id="r_user"></select>
      <button class="big" id="r_go">重置进度</button>
      <pre id="r_result" class="muted"></pre>
    </div>
    <div class="admin-cols">
```

- [ ] **Step 2: 在 `dashboard()` 里接面板交互**

在 `#imp` 按钮 handler 之后、`wrap.querySelector("#wlist")` 那行之前，插入：

```js
  // ---- 重置进度面板 ----
  const rUser = wrap.querySelector("#r_user");
  progress.forEach(u => { const o = document.createElement("option"); o.value = u.id; o.textContent = `${u.avatar} ${u.name}`; rUser.appendChild(o); });
  const rBoth = document.createElement("option"); rBoth.value = "all"; rBoth.textContent = "两个孩子"; rUser.appendChild(rBoth);

  const rScope = wrap.querySelector("#r_scope");
  const rTarget = wrap.querySelector("#r_target");
  function fillResetTarget() {
    rTarget.innerHTML = "";
    if (rScope.value === "global") { rTarget.style.display = "none"; return; }
    rTarget.style.display = "";
    const items = rScope.value === "unit"
      ? units.map(u => ({ value: u.id, label: `${u.book} · ${u.unit}` }))
      : [...new Set(units.map(u => u.book))].map(b => ({ value: b, label: b }));
    items.forEach(it => { const o = document.createElement("option"); o.value = it.value; o.textContent = it.label; rTarget.appendChild(o); });
  }
  rScope.onchange = fillResetTarget;
  fillResetTarget();

  wrap.querySelector("#r_go").onclick = async () => {
    const userVal = rUser.value;
    const user_ids = userVal === "all" ? progress.map(u => u.id) : [Number(userVal)];
    const userLabel = userVal === "all" ? "两个孩子" : (progress.find(u => String(u.id) === userVal)?.name || "");
    const body = { scope: rScope.value, user_ids };
    let targetLabel = "全部单元";
    if (rScope.value === "unit") { body.unit_id = Number(rTarget.value); targetLabel = rTarget.selectedOptions[0]?.textContent || ""; }
    else if (rScope.value === "book") { body.book = rTarget.value; targetLabel = rTarget.value; }
    if (!confirm(`确定重置「${targetLabel}」的 ${userLabel} 单元覆盖进度？\n相关单词会重新出现；已掌握度与星星保留。`)) return;
    try {
      const r = await api("/reset-progress", { method: "POST", body: JSON.stringify(body) });
      wrap.querySelector("#r_result").textContent = `已重置 ${r.deleted} 条覆盖记录`;
      dashboard();
    } catch (e) { wrap.querySelector("#r_result").textContent = e.message; }
  };
```

- [ ] **Step 3: 本地冒烟（端点连调）**

```bash
npm run dev   # wrangler dev，监听 :8787
```
另开终端，用 `.dev.vars` 里的 token（`test-admin-token`）打一次全局重置，确认返回 `deleted` 计数（注意 `--noproxy '*'`，本机 dev 受 127.0.0.1:1081 代理影响）：
```bash
curl --noproxy '*' -s localhost:8787/api/admin/reset-progress \
  -H 'content-type: application/json' -H 'x-admin-token: test-admin-token' \
  -d '{"scope":"global","user_ids":[1]}'
```
Expected: `{"ok":true,"deleted":<N>}`（N 为库里 user_id=1 的覆盖行数；重复调用第二次应大幅变小）。

- [ ] **Step 4: 浏览器冒烟（面板 UI）**

打开 `http://localhost:8787/admin.html`，输入口令 `test-admin-token` 进入。确认：
- 「重置进度」面板出现在 进度 与 新建单元 之间。
- 范围切到「全局」时目标下拉隐藏；切「按单元/按课本」时目标下拉有对应选项。
- 点「重置进度」弹 confirm，取消则不动作；确认后 `#r_result` 显示「已重置 N 条覆盖记录」，dashboard 自动刷新。

- [ ] **Step 5: 提交**

```bash
git add public/admin.js
git commit -m "feat(admin): 重置进度统一面板（单元/书/全局 × 单/双孩子）"
```

---

## Task 3: 收尾验证

- [ ] **Step 1: 全量测试**

```bash
npm test
```
Expected: 全绿（原 32 + 新增 6 = 38 条，且无回归）。

- [ ] **Step 2: 自检清单**
- 端点仅在 `user_unit_word_seen` 上 DELETE，未触碰 `user_word_state` / `user_stats`（已被单测断言）。
- `user_ids` 走参数化绑定，无字符串拼接（肉眼复核 `placeholders` 仅 `?`）。
- 前端「两个孩子」展开为全部 user id；书名/单元/孩子均来自 `/units`、`/progress`，无硬编码 id。

- [ ] **Step 3: 部署（如需上线）**

```bash
wrangler deploy
```
（schema 未变，无需 D1 迁移。）

---

## 自检（plan ↔ spec 覆盖）

| Spec 要求 | 覆盖 |
|---|---|
| 单一端点 `POST /reset-progress`，body `{scope,unit_id?,book?,user_ids}` | Task 1 Step 3 |
| 只删 `user_unit_word_seen`，不动 state/stats | Task 1 测试 + Step 3 代码 |
| 三种 scope 的 WHERE（unit/book 子查询/global） | Task 1 Step 3 |
| `user_ids` 参数化防注入 | Task 1 Step 3 + Task 3 Step 2 |
| 参数校验 400 / 鉴权 401 | Task 1 Step 1（测试 1、2） |
| 返回 `deleted` 计数 | Task 1 Step 3 + 测试断言 |
| 统一面板：范围/目标/孩子 + confirm | Task 2 Step 1–2 |
| 书名/单元/孩子复用已有 `/units`、`/progress` | Task 2 Step 2（不新增查询端点） |
| 7 类测试用例 | Task 1 Step 1（auth/validation/unit/book/global/单&双孩子/计数） |

无占位符；类型/命名一致（`scope`/`unit_id`/`book`/`user_ids`/`deleted` 全程统一）。
