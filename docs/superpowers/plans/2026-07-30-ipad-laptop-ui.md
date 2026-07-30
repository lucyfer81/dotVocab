# dotVocab iPad / 笔记本 UI 适配 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 dotVocab 孩子端在 iPad 横版（≥1024px）舒展重排、家长端在 13/14 寸笔记本改为双栏仪表盘，同时手机端（<1024px）逐字节不变。

**Architecture:** 纯前端改动。新增单一媒体查询 `@media (min-width:1024px)` 驱动所有重排；`.grid` 改 `auto-fill` 自动多列；家长端用 `<body class="admin">` 作用域出独立宽容器与双栏。后端 / API / D1 / SRS 零改动。

**Tech Stack:** vanilla JS（无框架）、单 `style.css`、Cloudflare Workers + Hono + D1。验证靠 Playwright 截图 + 现有 vitest API 测试作回归兜底。

**Spec:** `docs/superpowers/specs/2026-07-30-ipad-uiux-design.md`

---

## 关于测试方式的说明（重要）

本计划是**视觉/布局改动**，不引入任何可单测的业务逻辑（vanilla JS 的渲染函数未导出、项目无 DOM 测试基建）。因此：
- **不写新单元测试**（对 CSS/ markup 写假单测违反 YAGNI）。
- 每个任务的验证 = Playwright 截图核对 + 提交。
- `npm test`（现有 32 个 API 测试）在 Task 6 跑一次作整体回归兜底（UI 改动不应影响它们，但确认无误）。

## 文件结构

| 文件 | 责任 | 本计划改动 |
|---|---|---|
| `public/style.css` | 全局样式 | 主要：加 `≥1024px` 媒体查询、`.grid` 改 auto-fill、字号/间距、`.id-grid`、`.admin-cols` |
| `public/app.js` | 孩子端 SPA | 两处小改：身份网格加 `.id-grid` 类；首页加「待复习」stat |
| `public/admin.html` | 家长端入口 | `<body>` 加 `class="admin"` |
| `public/admin.js` | 家长端 SPA | `dashboard()` 改双栏 markup |
| `.superpowers/seed-local.sql` | 本地验证用种子数据（gitignored） | 新建，仅本地 |

手机端安全保证：所有新增 CSS 规则均置于 `@media (min-width:1024px)`；`.grid` 改 `auto-fill` 在 560px 手机容器内仍为 2 列（528px/200px≈2），视觉不变。

---

## Task 1: 本地开发环境与种子数据（基线，不提交）

**目标：** 跑起 `wrangler dev` 并灌入最小数据，让身份/首页/拼写页能截图；确认 Playwright 能访问本地服务（否则后续任务改用部署后的线上 URL 验证）。

**Files:**
- Create: `.superpowers/seed-local.sql`（gitignored，仅本地）

- [ ] **Step 1: 初始化本地 D1（幂等，已有则跳过）**

Run:
```bash
npx wrangler d1 execute dotvocab --local --file=migrations/0001_init.sql
```
Expected: 建表 + 插入 哥哥/弟弟 两个用户（`INSERT OR IGNORE`，重复执行安全）。

- [ ] **Step 2: 写入种子数据文件**

Create `.superpowers/seed-local.sql`:
```sql
INSERT OR IGNORE INTO units (book, unit, sort_key) VALUES ('人教PEP三上','Unit 1',1), ('人教PEP三上','Unit 2',2);
INSERT OR IGNORE INTO words (term, pos, meaning_cn, example_en, example_cn, created_at) VALUES
  ('apple','n.','苹果','I eat an apple.','我吃一个苹果。',0),
  ('banana','n.','香蕉','The banana is yellow.','香蕉是黄色的。',0),
  ('orange','n.','橙子','She likes orange juice.','她喜欢橙汁。',0),
  ('teacher','n.','老师','My teacher is kind.','我的老师很和蔼。',0),
  ('student','n.','学生','He is a student.','他是学生。',0),
  ('run','v.','跑','I run fast.','我跑得快。',0),
  ('library','n.','图书馆','We read in the library.','我们在图书馆阅读。',0),
  ('beautiful','adj.','美丽的','A beautiful day.','美丽的一天。',0);
INSERT OR IGNORE INTO unit_words (unit_id, word_id)
  SELECT u.id, w.id FROM units u, words w WHERE u.unit='Unit 1' AND w.term IN ('apple','banana','orange','teacher');
INSERT OR IGNORE INTO unit_words (unit_id, word_id)
  SELECT u.id, w.id FROM units u, words w WHERE u.unit='Unit 2' AND w.term IN ('student','run','library','beautiful');
```

- [ ] **Step 3: 灌入种子数据**

Run:
```bash
npx wrangler d1 execute dotvocab --local --file=.superpowers/seed-local.sql
```
Expected: 插入 2 个单元、8 个词、8 条 unit_words 关联。

- [ ] **Step 4: 启动本地服务（后台）**

Run (background):
```bash
npm run dev
```
Expected: `wrangler dev` 监听 `http://localhost:8787`，日志出现 `Ready on http://localhost:8787`。

- [ ] **Step 5: 用 Playwright 取手机基线截图（390×844）**

> 本环境有出站代理 `http_proxy=127.0.0.1:1081`。若 Playwright 打不开 `localhost:8787`（代理拦截本地回环），先在启动 wrangler 的 shell 设 `NO_PROXY=localhost,127.0.0.1` 再重启；仍不行则本任务及后续截图改用部署后的线上 URL（见 Task 6）。

- `browser_resize` → width 390, height 844
- `browser_navigate` → `http://localhost:8787/` → 应见「谁在背单词？」+ 哥哥/弟弟 两张卡片
- `browser_take_screenshot`（保存为基线，供后续比对手机端是否被改动影响）
- 点「哥哥」头像 → 进首页（应见 ⭐/🔥 stat、「今日复习」按钮、Unit 1/Unit 2 两张单元卡）→ 截图
- 点「Unit 1」→ 进新词/拼写页 → 截图

Expected: 三屏均正常渲染、有数据；手机端布局与现状一致（560px 居中单列、2 列网格）。这组截图即「手机端未被破坏」的对照基线。

- [ ] **Step 6: 不提交**（本任务仅为环境与基线）

---

## Task 2: 全局响应式地基（style.css）

**目标：** 加 `≥1024px` 媒体查询：容器放宽、`.grid` 自动多列、字号/间距放大。纯 CSS，孩子端首页/学习页此刻即舒展。

**Files:**
- Modify: `public/style.css:13`（`.grid`）
- Modify: `public/style.css`（末尾追加媒体查询块）

- [ ] **Step 1: 把 `.grid` 固定两列改为响应式 auto-fill**

In `public/style.css`, replace:
```css
.grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
```
with:
```css
.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:10px; }
```
（手机 560px 内仍 2 列；横版 920px 内约 4 列。）

- [ ] **Step 2: 末尾追加 ≥1024px 媒体查询块**

Append to `public/style.css`:
```css

/* ---------- ≥1024px: iPad 横版 / 笔记本 适配 ---------- */
@media (min-width: 1024px) {
  #app { max-width: 920px; padding: 24px; }
  body.admin #app { max-width: 1120px; }          /* 家长端笔记本更宽，Task 5 启用 */

  h1 { font-size: 30px; } h2 { font-size: 24px; } h3 { font-size: 20px; }
  .stat { font-size: 20px; padding: 10px 18px; }
  .big, .card { font-size: 22px; padding: 18px; }
  #review { padding: 22px; font-size: 26px; font-weight: 600; }   /* 今日复习 hero，Task 3 关联 */
  .avatar { font-size: 56px; }
  .id-grid { max-width: 460px; margin: 0 auto; }                 /* 身份页封顶，Task 3 关联 */
  .meaning.big { font-size: 32px; }
  .ex { max-width: 60ch; font-size: 18px; }
  .cmp { font-size: 32px; }
  .study input { max-width: 480px; }
  .fb { font-size: 22px; }

  .admin-cols { display: grid; grid-template-columns: 360px 1fr; gap: 16px; align-items: start; }  /* Task 5 */
  .admin-right { max-height: 72vh; overflow: auto; }                                               /* Task 5 */
}
```

- [ ] **Step 3: 截图核对（1024×768 横版）**

- `browser_resize` → 1024×768
- `browser_navigate` → `http://localhost:8787/` → 截图身份页
- 点「哥哥」→ 首页 → 截图

Expected:
- 内容带加宽（~920px 居中，两侧留白显著缩小）
- 单元网格变 **4 列**
- 字号/卡片/按钮明显变大
- **回归核对**：再 `browser_resize` → 390×844，刷新，对照 Task 1 基线——手机端布局应**完全一致**（2 列、560px 居中）。

- [ ] **Step 4: 提交**

```bash
git add public/style.css
git commit -m "feat(ui): ≥1024px 响应式地基——容器加宽、grid 自动多列、字号放大"
```

---

## Task 3: 孩子端身份页封顶 + 首页 stat/hero（app.js + style.css）

**目标：** 身份页头像网格横版下封顶居中（防过大）；首页加「待复习 N」stat、「今日复习」按钮变 hero。CSS 已在 Task 2 备好（`.id-grid`、`#review`），本任务只接入 class 与新 stat。

**Files:**
- Modify: `public/app.js:38`（身份网格加 class）
- Modify: `public/app.js:58`（首页 stats 加待复习）
- （`public/style.css` 的 `.id-grid`、`#review` 规则已在 Task 2 写入，无需再改）

- [ ] **Step 1: 身份页网格加 `.id-grid` 类**

In `public/app.js`, the `showIdentity()` template (around line 38) currently has:
```js
  const wrap = $(`<section><h1>谁在背单词？</h1><div class="grid"></div></section>`);
```
replace with:
```js
  const wrap = $(`<section><h1>谁在背单词？</h1><div class="grid id-grid"></div></section>`);
```

- [ ] **Step 2: 首页 stats 增加「待复习 N」**

In `public/app.js`, the `showHome()` template (around line 58) currently has:
```js
    <div class="stats"><div class="stat">⭐ ${home.stars}</div><div class="stat">🔥 ${home.streak_days}</div></div>
```
replace with:
```js
    <div class="stats"><div class="stat">⭐ ${home.stars}</div><div class="stat">🔥 ${home.streak_days}</div><div class="stat">📥 待复习 ${home.due_count}</div></div>
```
（`home.due_count` 由 `/api/home` 返回，无需后端改动。）

- [ ] **Step 3: 截图核对（1024×768）**

- `browser_resize` → 1024×768
- `browser_navigate` → `http://localhost:8787/` → 身份页：两张头像卡居中、宽度适中（~460px 内），不过大 → 截图
- 点「哥哥」→ 首页：stat 栏现为**三个**（⭐ / 🔥 / 📥 待复习 N），「今日复习」按钮变宽幅 hero（更大字号）→ 截图

Expected: 身份卡不撑满 920px；首页出现「待复习」并显示数字（如 `📥 待复习 0` 或实际到期数）；今日复习按钮明显变大居中。

- [ ] **Step 4: 提交**

```bash
git add public/app.js
git commit -m "feat(ui): 身份页网格封顶 + 首页新增「待复习」stat"
```

---

## Task 4: 学习会话输入框/例句收窄（style.css）

**目标：** 拼写输入框横版下收窄聚焦、例句限宽防过长。CSS 规则（`.study input`、`.ex`）已在 Task 2 写入；本任务仅验证（确认 Step 无需改码，规则已生效）。

**Files:**
- 无新改动（Task 2 的 `.study input { max-width:480px }` 与 `.ex { max-width:60ch }` 已覆盖）。若 Task 2 未含此二行，补到同一媒体查询块内。

- [ ] **Step 1: 确认规则已在媒体查询块内**

打开 `public/style.css`，确认 `@media (min-width:1024px)` 块内含：
```css
  .ex { max-width: 60ch; font-size: 18px; }
  .study input { max-width: 480px; }
```
若缺失则补入。

- [ ] **Step 2: 截图核对拼写页（1024×768）**

- `browser_resize` → 1024×768
- `browser_navigate` → `http://localhost:8787/` → 点「哥哥」→ 首页点「Unit 1」→ 进入新词卡（点「开始拼写」）→ 拼写页 → 截图

Expected: 拼写 `<input>` 宽度约 ≤480px（不跟随 920px 容器拉满）；释义（`.meaning.big`）、例句（`.ex`）字号放大、例句在 ~60 字符处换行；提交按钮仍为容器全宽 CTA。

- [ ] **Step 3: 提交（如有补改）**

仅当 Step 1 补了规则时：
```bash
git add public/style.css
git commit -m "feat(ui): 学习页输入框收窄 + 例句限宽"
```
否则跳过提交（规则已在 Task 2 提交）。

---

## Task 5: 家长端笔记本双栏仪表盘（admin.html + admin.js + style.css）

**目标：** 家长端 `body.admin` 启用 ~1120px 宽容器 + 双栏（左操作 / 右词库独立滚动）。CSS 已在 Task 2 备好（`body.admin #app`、`.admin-cols`、`.admin-right`）。

**Files:**
- Modify: `public/admin.html:9`（`<body>` 加 class）
- Modify: `public/admin.js:35-49`（`dashboard()` 模板改双栏）
- （`public/style.css` 规则已在 Task 2 写入）

- [ ] **Step 1: admin.html 的 body 加 class**

In `public/admin.html`, replace:
```html
<body>
```
with:
```html
<body class="admin">
```

- [ ] **Step 2: dashboard() 模板改为双栏结构**

In `public/admin.js`, the `dashboard()` `wrap` template currently reads:
```js
  const wrap = $(`<section>
    <header class="top"><h1>家长后台</h1><button class="link" id="out">退出</button></header>
    <h2>进度</h2><div id="prog"></div>
    <h2>新建单元</h2>
    <input id="book" placeholder="课本（如 人教PEP三上）" />
    <input id="unit" placeholder="单元（如 Unit 1）" />
    <input id="sort" placeholder="排序号（数字，可空）" />
    <button class="big" id="addunit">添加单元</button>
    <h2>导入单词到单元</h2>
    <select id="target"></select>
    <textarea id="csv" rows="6" placeholder="每行: 英文,中文释义,词性,例句英,例句中&#10;例: apple,苹果,n&#10;banana,香蕉"></textarea>
    <button class="big" id="imp">导入</button>
    <pre id="impresult" class="muted"></pre>
    <h2>词库 (${words.length})</h2><div id="wlist"></div>
  </section>`);
```
replace with（用 `.admin-cols` 包裹，左 `.admin-left` 放操作、右 `.admin-right` 放词库；进度保持全宽在上方）:
```js
  const wrap = $(`<section>
    <header class="top"><h1>家长后台</h1><button class="link" id="out">退出</button></header>
    <h2>进度</h2><div id="prog"></div>
    <div class="admin-cols">
      <div class="admin-left">
        <h2>新建单元</h2>
        <input id="book" placeholder="课本（如 人教PEP三上）" />
        <input id="unit" placeholder="单元（如 Unit 1）" />
        <input id="sort" placeholder="排序号（数字，可空）" />
        <button class="big" id="addunit">添加单元</button>
        <h2>导入单词到单元</h2>
        <select id="target"></select>
        <textarea id="csv" rows="6" placeholder="每行: 英文,中文释义,词性,例句英,例句中&#10;例: apple,苹果,n&#10;banana,香蕉"></textarea>
        <button class="big" id="imp">导入</button>
        <pre id="impresult" class="muted"></pre>
      </div>
      <div class="admin-right">
        <h2>词库 (${words.length})</h2><div id="wlist"></div>
      </div>
    </div>
  </section>`);
```
（所有 `id` 保持不变，后续 `querySelector("#prog")` / `#target` / `#wlist` 等处理器无需改动。）

- [ ] **Step 3: 截图核对家长端（1366×768 笔记本）**

家长端登录需管理员口令（`.dev.vars` 里的 `ADMIN_TOKEN`）。在登录框输入口令进入。

- `browser_resize` → 1366×768
- `browser_navigate` → `http://localhost:8787/admin.html`
- 输入口令 →「进入」→ 仪表盘 → 截图

Expected:
- 容器宽约 ~1120px（不再是 560px 细列）
- 进度条全宽置顶
- 下方**双栏**：左栏（新建单元 + 导入表单，约 360px），右栏（词库列表，独立滚动）
- **回归核对**：`browser_resize` → 390×844 刷新——家长端退化为单列上下结构（进度 → 新建 → 导入 → 词库），与改造前一致。

- [ ] **Step 4: 提交**

```bash
git add public/admin.html public/admin.js
git commit -m "feat(ui): 家长端笔记本双栏仪表盘（body.admin + admin-cols）"
```

---

## Task 6: 回归测试 + 部署 + 线上权威截图巡检

**目标：** API 回归兜底；部署到生产；在真实数据上对全部目标分辨率做权威截图巡检，确认手机端未变、横版/笔记本重排正确。

**Files:** 无（仅验证与部署）

- [ ] **Step 1: 跑 API 回归测试**

Run:
```bash
npm test
```
Expected: 全绿（32 个测试通过）。UI 改动不应影响 API；若有失败，说明误改了 `src/`，回查。

- [ ] **Step 2: 部署**

Run:
```bash
npm run deploy
```
Expected: `wrangler deploy` 成功，发布到 https://dotvocab.lucyfer81.workers.dev

- [ ] **Step 3: 线上权威截图巡检（真实数据）**

对线上 URL 截图（线上 D1 已有 真实孩子/单元/词数据）：

| 视口 | 页面 | 核对点 |
|---|---|---|
| 390×844（手机） | 身份 / 首页 / 拼写 / 家长端 | 与改造前一致（560px 单列、2 列网格、家长端单列）——**回归基准** |
| 1024×768（iPad 横） | 身份 / 首页 / 拼写 | ~920px 宽、4 列网格、stat 三项、hero 按钮、输入框收窄 |
| 1194×834（iPad 横） | 同上 | 同上，留白更小 |
| 1366×768（笔记本） | 家长端 | ~1120px 宽、双栏、词库独立滚动 |

每屏 `browser_take_screenshot` 留档。

Expected: 手机端四屏与基线一致；iPad 横版三屏重排如设计；笔记本家长端双栏。

- [ ] **Step 4: 收尾**

- 关闭本地 `wrangler dev`（如仍在跑）。
- 若巡检发现问题，回到对应 Task 修复后重新部署，再巡检。
- 全部通过即完成。

```bash
# 无新代码则不提交；此任务为验证与部署
```

---

## Self-Review 记录

- **Spec 覆盖：** 断点策略(Task2)、全局 CSS(Task2)、身份页封顶(Task3)、首页 stat+hero(Task3)、学习页输入/例句收窄(Task4)、家长端双栏(Task5)、手机安全(每 Task 回归核对 + Task6)、验证计划(Task6)——spec 各节均有对应 Task。
- **占位符：** 无 TBD/TODO；每步含具体代码或命令与预期输出。
- **类型/命名一致：** `.id-grid`、`#review`、`.admin-cols`、`.admin-left/right`、`.study input`、`.ex` 在 Task2(CSS 定义) 与 Task3/5(JS 接入) 间命名一致；`home.due_count` 与 `/api/home` 返回字段一致。
