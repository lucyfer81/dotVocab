# dotVocab iPad / 笔记本 UI 适配设计

- 日期：2026-07-30
- 状态：待评审
- 范围：前端 UI 适配（孩子端 iPad 横版 + 家长端笔记本），后端 / API / 数据库零改动

## 背景

dotVocab 当前是纯手机竖版单列 SPA，`#app` 锁死在 `max-width:560px` 居中。在 iPad 横版（≥1024px）和笔记本（≥1280px）上表现为一根细长列浮在大量留白里，空间浪费、控件偏小。

孩子（双胞胎三年级）只在 **iPad 横版** 上使用孩子端；家长只在 **13/14 寸笔记本** 上使用家长端。两者都不会用 iPad 竖版或手机访问对应界面（手机端保留给未来可能的移动访问，本设计不破坏它）。

## 目标与非目标

目标：
- 孩子端在 iPad 横版下舒展重排，用足空间、控件放大、单元网格多列，体验「为平板设计」而非「手机放大」。
- 家长端在笔记本下改为双栏仪表盘，左操作 / 右数据，减少长滚动。
- 手机端（<1024px）逐字节保持现状。

非目标：
- 不做 iPad 竖版适配（用户不会这样使用）。
- 不做 iPad 原生交互重构（手写笔、Split View 多任务、侧拉等超出「适配优化」范围）。
- 不改后端 / API / 数据模型 / SRS 逻辑。
- 不引入前端框架或构建步骤，继续 vanilla JS + 单 CSS 文件。

## 关键决策（brainstorm 结论）

| 维度 | 决策 |
|---|---|
| 整体策略 | 适配优化（舒展重排，B 档） |
| 孩子端设备 | iPad 横版，单一断点 `≥1024px` |
| 孩子端内容宽度 | 统一 ~80%（封顶 ~920px），不区分首页/学习页 |
| 单元网格 | `auto-fill minmax(200px,1fr)`：手机 2 列 → 横版 4 列 |
| 首页统计 | 加「待复习 N」stat（取 `/home` 已有的 `due_count`，零后端改动） |
| 学习页输入框 | 容器仍 80%，但 `<input>` 单独 `max-width ~480px` 收窄聚焦 |
| 家长端设备 | 13/14 寸笔记本（~1280–1440px） |
| 家长端布局 | 双栏（左操作 / 右数据），容器 ~1100px，不套用 80% |
| 手机端 | <1024px 完全不动 |

## 设计

### 断点策略

- **默认样式（无媒体查询）= 手机**：`<1024px`，保持现有 `#app { max-width:560px; ... }` 等，逐条不变。
- **单一断点 `@media (min-width: 1024px)`**：孩子端 iPad 横版重排 + 家长端笔记本重排共用此断点。
- 不设 768px 竖版断点。

### 全局 CSS（`public/style.css`）

```css
/* ≥1024px：孩子端容器放宽（横版 ~80%） */
@media (min-width: 1024px) {
  #app { max-width: 920px; padding: 24px; }
}

/* 家长端用 body.admin 作用域，覆盖为孩子端设定的宽度 */
@media (min-width: 1024px) {
  body.admin #app { max-width: 1120px; }
}
```

`.grid` 由固定两列改为响应式（手机 2 列不变，横版自动多列）：

```css
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
```

> 在 560px 手机容器内 `560/200≈2` 列，与现状两列一致；在 920px 横版内约 4 列。

宽屏下整体字号 / 内边距上一档（按钮 18→22px、释义 24→32px、`.cmp` 26→32px、`.avatar` 42→56px 等），均置于 `@media (min-width:1024px)` 内。

### 孩子端逐页（`public/app.js` + CSS）

**身份页**
- 当前头像网格复用 `.grid`，横版下 2 个头像会过疏过大。
- app.js 给身份页网格加类 `.id-grid`；CSS 横版封顶居中：`@media(min-width:1024px){ .id-grid{ max-width:460px; margin:0 auto; } }`。

**首页**
- 统计区 → 完整 stat 栏，并新增「待复习 N」：app.js home 渲染处追加 `<div class="stat">待复习 ${home.due_count}</div>`（值来自 `/home` 返回的 `due_count`，无后端改动）。
- 「今日复习」→ 宽幅 hero（主 CTA）。纯 CSS 按 id 作用域，不改 JS：`@media(min-width:1024px){ #review{ padding:22px; font-size:24px; font-weight:600; } }`。
- 单元网格随 `.grid` 自动 4 列；单元卡片内进度条与计数放大。

**学习会话（新词卡 / 拼写卡 / 完成页）**
- 释义、例句、术语字号放大透气；例句限宽防过长换行：`@media(min-width:1024px){ .ex{ max-width:60ch; } }`。
- 拼写输入框收窄聚焦（容器仍统一 920px）：`@media(min-width:1024px){ .study input{ max-width:480px; } }`。提交按钮保持容器全宽作为强 CTA。
- 完成页字号放大、庆祝感增强。纯 CSS。

### 家长端（`public/admin.html` + `public/admin.js` + CSS）

- `admin.html`：`<body>` 加 `class="admin"`（用于作用域宽容器与双栏；孩子端 `index.html` 不动）。
- `admin.js` 的 `dashboard()` 由单一顺序结构改为双栏结构：
  ```
  <section>
    header（家长后台 | 退出）
    进度（全宽，紧凑）
    <div class="admin-cols">
      <div class="admin-left">  新建单元 + 导入单词 </div>
      <div class="admin-right"> 词库（max-height + overflow:auto 独立滚动） </div>
    </div>
  </section>
  ```
- CSS（`≥1024px`）：
  ```css
  .admin-cols { display: grid; grid-template-columns: 360px 1fr; gap: 16px; }
  .admin-right { max-height: 72vh; overflow: auto; }
  ```
- 手机端（<1024px）`.admin-cols` 退化为单列（默认 block / 1 列），家长端在窄屏仍是上下结构。

## 实现要点

- **纯前端改动**，涉及文件：
  - `public/style.css`：主要改动（媒体查询、`.grid`、字号、`.id-grid`、`.admin-cols` 等）。
  - `public/app.js`：两处小改——身份网格加 `.id-grid` 类；首页追加「待复习」stat。
  - `public/admin.html`：`<body class="admin">`。
  - `public/admin.js`：`dashboard()` 改双栏 markup + 词库滚动容器。
- 后端、API、D1、SRS 逻辑零改动 → 现有 32 个测试不受影响。
- 不引入框架 / 构建步骤。
- 手机端安全：所有新增规则均置于 `@media (min-width:1024px)`，默认样式逐条保留；`.grid` 改 `auto-fill` 在手机容器内仍为 2 列，视觉不变。

## 验证计划

- `npm test`：现有 32 个测试须仍全绿（仅作回归兜底，本为 UI 改动）。
- 人工多分辨率截图核对（用 Playwright）：
  - **390×844（手机）**：孩子端与家长端每屏须与现状一致（回归基准）。
  - **1024×768、1194×834（iPad 横版）**：孩子端身份 / 首页 / 拼写 / 完成页，核对重排效果。
  - **1366×768（笔记本）**：家长端双栏仪表盘。
- 视觉回归为人工核对（项目无视觉测试基建）。

## 不在本期范围

- iPad 竖版适配。
- 手写笔拼写、Split View / 侧拉等多任务原生交互。
- 孩子端分屏 / 主从布局等「iPad 原生重设计」（C 档）。
- 视觉风格 / 配色 / 品牌重塑。
