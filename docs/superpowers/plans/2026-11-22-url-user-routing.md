# URL 直达账号（/xct /lcl）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/xct` 直达哥哥页面、`/lcl` 直达弟弟页面，URL 成为身份唯一来源。

**Architecture:** 纯前端改动。新模块 `public/user-routing.js` 持有代号↔用户名对照与解析函数；`public/app.js` 的 boot 按路径解析用户，删除 localStorage 记忆机制。后端、D1、manifest 零改动（SPA 兜底已让任意路径返回 index.html）。

**Tech Stack:** 原生 ES Module JavaScript（无构建步骤），vitest + @cloudflare/vitest-pool-workers。

**Spec:** `docs/superpowers/specs/2026-11-22-url-user-routing-design.md`

## Global Constraints

- 后端（src/）、数据库（migrations/）、`manifest.json`、admin 端零改动
- 防呆底线：代号匹配不到用户 → 明确报错页；绝不模糊匹配、绝不回退到另一个人
- 代号识别只做全等比较（trim + 小写规范化后），不做前缀/包含匹配
- UI 文案中文，风格与现有 emoji 风一致
- 测试命令：`npx vitest run <file>`；前端模块测试放 `test/`，import `../public/<module>.js`（惯例同 mistake-helpers.test.ts）

## Review Focus

| # | 输入/故障 | 期望行为 | 钉住它的测试 |
|---|---|---|---|
| 1 | 打错字的代号（`/xtc`）、多级路径（`/foo/bar`） | 显示选择页，不崩、不猜人 | Task 1: nameForSlug 未知→null、slugFromPath 多级路径 |
| 2 | 数据库用户名改动导致匹配不到 | 明确报错页「找不到用户」，绝不回退 | Task 1: resolveUser 名字缺失→null |
| 3 | 大小写/尾斜杠（`/XCT`、`/xct/`） | 规范化后正常识别 | Task 1: 规范化用例 |
| 4 | 旧浏览器残留 localStorage `dotvocab_user` | 新逻辑必须忽略它（弟弟设备上开 `/lcl` 不能因旧记忆进哥哥页） | Task 2 冒烟第 5 条 |
| 5 | 刷新 `/xct`、从会话返回首页 | 仍进哥哥页面（URL 每次重新解析） | Task 2 冒烟第 6 条 |

---

### Task 1: user-routing 模块（对照表 + 解析函数）

**Files:**
- Create: `public/user-routing.js`
- Test: `test/user-routing.test.ts`

**Interfaces:**
- Consumes: 无（纯函数模块）
- Produces（Task 2 依赖的精确签名）:
  - `slugFromPath(pathname: string): string` — `/xct`→`"xct"`，`/xct/`→`"xct"`，`/`→`""`，`/foo/bar`→`"foo/bar"`；结果已小写
  - `nameForSlug(slug: string): string | null` — `"xct"`→`"哥哥"`，`"lcl"`→`"弟弟"`；未知（含空串、多级路径）→ `null`；内部先 trim+小写
  - `resolveUser(slug: string, users: {id:number,name:string,avatar:string}[]): {id,name,avatar} | null` — 按 nameForSlug 得到的名字在 users 里找 name 全等项；名字为 null 或找不到 → `null`
  - `SLUG_BY_NAME: Record<string, string>` — `{ "哥哥": "xct", "弟弟": "lcl" }`

- [ ] **Step 1: 写失败测试 `test/user-routing.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { slugFromPath, nameForSlug, resolveUser, SLUG_BY_NAME } from "../public/user-routing.js";

const users = [
  { id: 1, name: "哥哥", avatar: "👦" },
  { id: 2, name: "弟弟", avatar: "👶" },
];

describe("slugFromPath", () => {
  it.each([["/xct", "xct"], ["/xct/", "xct"], ["/XCT", "xct"], ["/", ""], ["", ""], ["/foo/bar", "foo/bar"]])
    ("%s -> %s", (path, want) => expect(slugFromPath(path)).toBe(want));
});

describe("nameForSlug", () => {
  it("maps known slugs", () => {
    expect(nameForSlug("xct")).toBe("哥哥");
    expect(nameForSlug("lcl")).toBe("弟弟");
  });
  it("normalizes case and whitespace before comparing", () => {
    expect(nameForSlug(" XCT ")).toBe("哥哥");
  });
  it("returns null for unknown slug, empty, multi-segment path", () => {
    expect(nameForSlug("xtc")).toBeNull();
    expect(nameForSlug("")).toBeNull();
    expect(nameForSlug("foo/bar")).toBeNull();
  });
});

describe("resolveUser", () => {
  it("finds the user by exact name match", () => {
    expect(resolveUser("xct", users)).toEqual(users[0]);
    expect(resolveUser("lcl", users)).toEqual(users[1]);
  });
  it("returns null when name missing from users — never falls back to another user", () => {
    expect(resolveUser("xct", [{ id: 9, name: "小虎", avatar: "🐯" }])).toBeNull();
    expect(resolveUser("xtc", users)).toBeNull();
  });
});

describe("SLUG_BY_NAME", () => {
  it("is the exact two-account table", () => {
    expect(SLUG_BY_NAME).toEqual({ "哥哥": "xct", "弟弟": "lcl" });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/user-routing.test.ts`
Expected: FAIL（模块不存在，import 报错）

- [ ] **Step 3: 实现 `public/user-routing.js`**

四个导出见 Interfaces。实现要点：`slugFromPath` 去首尾 `/` 后小写；`nameForSlug` 先 trim+小写再反转 `SLUG_BY_NAME` 查表（表值统一小写）；`resolveUser` 用 `users.find(u => u.name === name)`，name 为 null 直接返回 null。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/user-routing.test.ts`
Expected: PASS 全绿

- [ ] **Step 5: Commit**

```bash
git add public/user-routing.js test/user-routing.test.ts
git commit -m "feat(routing): 代号↔用户名对照与解析模块 user-routing"
```

---

### Task 2: app.js 集成（boot 按 URL 定身份，删 localStorage 记忆）

**Files:**
- Modify: `public/app.js`（头部 import、`currentUser` 初始化、`showIdentity`、`showHome` 的 `#switch`、boot 函数，约第 1-11、73-88、102、354-362 行）

**Interfaces:**
- Consumes: Task 1 的 `slugFromPath` / `nameForSlug` / `resolveUser` / `SLUG_BY_NAME`
- Produces: 无（终端 UI 集成）

- [ ] **Step 1: 改造 `app.js`**

1. 顶部 import：`import { slugFromPath, nameForSlug, resolveUser, SLUG_BY_NAME } from "./user-routing.js";`
2. 删除 currentUser 的 localStorage 读取（第 9-11 行），保留 `let currentUser;` 声明；boot 开头加 `localStorage.removeItem("dotvocab_user");` 清旧残留
3. `showIdentity()`：卡片 onclick 改为 `const slug = SLUG_BY_NAME[u.name]; if (slug) location.href = "/" + slug;`（无代号的用户不跳转）
4. `showHome()` 的 `#switch`：改为 `location.href = "/"`（删掉 localStorage.removeItem + showIdentity 旧逻辑）
5. boot 重写：

```js
(async function boot() {
  localStorage.removeItem("dotvocab_user");
  try {
    // 未知代号（打错字、多级路径）宽容回选择页；已知代号但数据库对不上才报错
    const slug = slugFromPath(location.pathname);
    if (!slug || !nameForSlug(slug)) return await showIdentity();
    const u = resolveUser(slug, await api("/users"));
    if (!u) {
      render($(`<section><h2>🧭 没找到这位宇航员</h2>
        <p class="bad">链接里的代号（${escapeHtml(slug)}）对不上任何用户</p>
        <button class="big" id="back">回基地选人</button></section>`));
      document.getElementById("back").onclick = () => { location.href = "/"; };
      return;
    }
    currentUser = u;
    await showHome();
  } catch (e) {
    render($(`<section><p class="bad">网络出错了：${escapeHtml(e.message)}</p><button class="big" onclick="location.reload()">重试</button></section>`));
  }
})();
```

- [ ] **Step 2: 全量测试回归（后端零改动，应全绿）**

Run: `npm test`
Expected: 全部 PASS（含 Task 1 的 user-routing.test.ts）

- [ ] **Step 3: 手工冒烟（`npx wrangler dev`）**

逐项验证（对应 Review Focus）：
1. `/xct` → 哥哥首页（头像名字对）；`/lcl` → 弟弟首页
2. `/` → 选择页；点哥哥卡片 → URL 跳 `/xct` 进哥哥首页
3. `/xtc`（打错字）→ 显示选择页，不报错不猜人
4. `/xct/`、`/XCT` → 均进哥哥首页
5. DevTools 里预置 `localStorage.setItem("dotvocab_user", JSON.stringify({id:1,name:"哥哥",avatar:"👦"}))` 后开 `/lcl` → 仍进弟弟首页（旧记忆被忽略）
6. `/xct` 刷新 → 仍哥哥首页；进会话答一题返回基地 → 数据记在哥哥（user_id=1）名下
7. 首页「切换用户」→ 回 `/` 选择页

- [ ] **Step 4: 部署上线**

Run: `npm run deploy`
Expected: 部署成功后，线上 `https://vocab.aizhi.app/xct` 与 `/lcl` 分别直达哥哥、弟弟页面（浏览器各开一次验证）

- [ ] **Step 5: Commit**

```bash
git add public/app.js docs/superpowers/specs/2026-11-22-url-user-routing-design.md docs/superpowers/plans/2026-11-22-url-user-routing.md
git commit -m "feat(routing): /xct /lcl URL 直达账号，URL 为身份唯一来源"
```
