# 背单词卡片字号与布局重做

- 日期：2026-07-31
- 状态：待评审
- 范围：孩子端「新词介绍卡」+「拼写卡」的字号与布局（纯前端，零后端 / 数据改动）
- 关联：`docs/superpowers/specs/2026-07-30-ipad-uiux-design.md`（沿用其单断点 `≥1024px` 约定与默认=手机的策略）

## 背景

孩子（三年级双胞胎）在 iPad 与手机上反映：背单词界面的**单词、中文释义、读音图标太小**。

根因（已核对源码）：

- 介绍卡（`app.js` `showWordIntro`）把单词 / 释义放进 `<div class="wordcard">`，但 `public/style.css` 里**根本没有 `.wordcard` 这条规则**——这是个空 class，没有卡片框、没有内边距。
- 单词 `<div class="term">`、释义 `<div class="meaning">`（非 `.big`）、读音按钮 `<button class="link">` 在 CSS 里**都没有写字号**，全部回落到浏览器默认 ~16px。
- 2026-07-30 的 iPad 适配在 `@media(min-width:1024px)` 里放大了 `h1/h2/h3`、`.stat`、`.big`/`.card`、`.meaning.big`、`.ex`、`.cmp`、`.study input`、`.fb`，但**漏掉了 `.term`、`.meaning`（非 big）、`.link`**。于是 iPad 上标题/按钮都大了，唯独这张介绍卡的字没动，反差更显小。

结果：介绍卡上单词 / 释义 / 🔊 是 ~16px 的裸文字，无卡片框、左对齐堆在屏幕左上角。

拼写卡（`spellingCard`）的释义用的是 `.meaning.big`（24/32px），已经放大，但与介绍卡风格脱节，且没有卡片框。

## 目标与非目标

目标：
- 介绍卡：单词、中文释义放大到三年级孩子舒适可读；套上白底卡片框，不再裸奔左上角；读音从 16px 小链接按钮改为「整词可点即读」。
- 拼写卡：套用同一套字号体系与同一种白卡片框，让「看词 → 拼写」两步视觉连贯。
- 手机与 iPad 双端一致改善；iPad 宽屏下卡片收窄居中，不散开。

非目标：
- 不改后端 / API / D1 / SRS。
- 不加音标（IPA）文字（决定走 A+C：单词本身即最大点击区，🔊 仅作提示；不补数据）。
- 不动首页 / 单元列表 / 身份页 / 完成页 / 家长端。
- 不引入框架 / 构建步骤，继续 vanilla JS + 单 CSS。
- 不改全局 `h2`（被多页面共用，2026-07-30 spec 已定为 18/24px，保持）。

## 关键决策（brainstorm 结论）

| 维度 | 决策 |
|---|---|
| 范围 | B：介绍卡 + 拼写卡统一字号体系 |
| 布局 | A：居中英雄式（视觉焦点全在词，🔊 跟着词走） |
| 读音交互 | A+C：整词区可点即读（最大点击区），🔊 仅作视觉提示 |
| 单词字号 | 手机 40px / iPad 56px |
| 中文释义字号 | 手机 26px / iPad 32px（统一 `.meaning`，不再用 `.meaning.big`） |
| 卡片框 | 新增 `.wordcard` 样式：白底、圆角 18、内边距、轻阴影；iPad `max-width:480px` 居中 |
| 数据 | 零改动（不加音标字段） |

## 设计

### 字号体系（type scale）

新增默认（手机）字号，并在 `@media(min-width:1024px)` 上一档：

| 元素 | 手机（默认） | iPad（≥1024px） | 现状 |
|---|---|---|---|
| 单词 `.term` | 40px / 700 | 56px / 700 | 无规则（~16px）❌ |
| 中文释义 `.meaning` | 26px | 32px | 无规则（~16px）❌ |
| 词性 `.pos` | 15px 灰 | 17px 灰 | 与释义同字号 |
| 例句英 `.ex` | 17px | 19px | ~16px（iPad 已 18px） |
| 例句中（`.ex .muted`） | 15px 灰 | 17px 灰 | ~16px |
| 朗读提示 `.tap-hint` | 12px 灰 | 13px 灰 | 新增 |
| 拼写输入框 `.study input` | 22px（保持） | 24px | 22px |

> 全局 `h2`（18/24px）、`.cmp`（26/32px）、`.fb`（20/22px）沿用 2026-07-30 spec，本期不动。

### CSS 新增 / 修改（`public/style.css`）

默认（手机）段新增：

```css
/* 卡片框：原 .wordcard 是空 class，现落实样式 */
.wordcard { background:#fff; border-radius:18px; padding:24px 22px; margin:8px 0;
            box-shadow:0 2px 10px rgba(0,0,0,.05); text-align:center; }

/* 介绍卡：整词可点即读区 */
.tap-word { display:block; width:100%; border:0; background:#f0f7ff; border-radius:12px;
            padding:12px 8px; cursor:pointer; text-align:center; color:#1e3a8a; }
.tap-word .term { font-size:40px; font-weight:700; line-height:1.15; }
.tap-word .audio-hint { font-size:30px; margin-left:6px; }
.tap-word .tap-hint { display:block; font-size:12px; color:#9ca3af; margin-top:4px; }

/* 释义 / 词性 / 例句：默认即放大（不再依赖 .meaning.big） */
.meaning { font-size:26px; line-height:1.3; margin-top:16px; }
.meaning .pos { font-size:15px; color:#9ca3af; margin-right:4px; }
.wordcard .ex { font-size:17px; margin-top:12px; }
.wordcard .ex .muted { font-size:15px; }
```

iPad 段（`@media(min-width:1024px)`）新增：

```css
.wordcard { max-width:480px; margin-left:auto; margin-right:auto; padding:28px 26px; }
.tap-word .term { font-size:56px; }
.tap-word .audio-hint { font-size:40px; }
.tap-word .tap-hint { font-size:13px; }
.meaning { font-size:32px; }
.meaning .pos { font-size:17px; }
.wordcard .ex { font-size:19px; }
.wordcard .ex .muted { font-size:17px; }
.study input { font-size:24px; }
```

清理：原 `.meaning.big { font-size:24px; margin:10px 0; }` 及 iPad 段 `.meaning.big { font-size:32px; }` 不再被引用（拼写卡改用 `.meaning`），可删除以避免混淆。`.ex` 的全局规则（颜色 / 外边距 / iPad 段 `max-width:60ch`）保留不动；新增的 `.wordcard .ex` 选择器特异性更高，仅在卡片内覆盖字号，不影响别处。

> 标记示例中 `${term}` / `${meaning_cn}` 等为简写，**实现时必须沿用现有 `escapeHtml(...)` 包裹**（数据虽为家长端录入，仍防注入与排版破坏）。

### 标记修改（`public/app.js`）

**`showWordIntro`（介绍卡）**——把单独的 `<button class="link">🔊</button>` 换成「整词可点区」，`#play` 处理器不变（`speak(w.term)`）：

```html
<section class="study">
  <h2>${title}</h2>
  <div class="wordcard">
    <button class="tap-word" id="play" aria-label="朗读单词">
      <span class="term">${term}</span><span class="audio-hint">🔊</span>
      <small class="tap-hint">点单词朗读</small>
    </button>
    <div class="meaning">${pos ? `<span class="pos">${pos}.</span>` : ""}${meaning_cn}</div>
    ${example_en ? `<div class="ex">${example_en}<br><span class="muted">${example_cn || ""}</span></div>` : ""}
  </div>
  <button class="big" id="start">开始拼写</button>
</section>
```

**`spellingCard`（拼写卡）**——释义由 `.meaning big` 改为 `.meaning`，并套入 `.wordcard`：

```html
<section class="study">
  <h2>${title}</h2>
  <div class="progress"><i id="bar"></i></div>
  <div class="wordcard">
    <div class="meaning">${pos ? `<span class="pos">${pos}.</span>` : ""}${meaning_cn}</div>
    ${example_en ? `<div class="ex">${example_en}</div>` : ""}
  </div>
  <input id="ans" autocapitalize="none" autocomplete="off" spellcheck="false" placeholder="拼写英文单词" />
  <div id="fb" class="fb"></div>
  <button class="big" id="submit">提交</button>
</section>
```

> 拼写卡不显示单词（正在考）、不加朗读按钮；提交后由现有逻辑 `speak(w.term)` 朗读，不变。

## 实现要点

- **纯前端**，涉及文件仅 `public/style.css` + `public/app.js`（`showWordIntro`、`spellingCard` 两处）。
- 沿用单断点 `@media(min-width:1024px)`；默认样式即手机，手机端回归基准基本不变（介绍卡本就在手机上偏小，本次为有意改善，不属「保持现状」）。
- `.term` / `.meaning` / `.wordcard` 经核对仅出现在学习会话两张卡，新增全局规则不影响首页 / 身份页 / 家长端。
- 后端 / API / D1 / SRS 零改动 → 现有测试不受影响。
- `<button class="tap-word">` 内嵌 `<span>/<small>`，注意重置按钮默认样式（已在 `.tap-word` 中 `border:0; background; width:100%`）。

## 验证计划

- `npm test`：现有测试须仍全绿（回归兜底）。
- Playwright 多分辨率人工截图核对：
  - **390×844（手机）**：介绍卡单词 40px、释义 26px、整词可点；拼写卡释义 26px、卡片框。
  - **1024×768 / 1194×834（iPad 横版）**：单词 56px、释义 32px、卡片收窄 480px 居中。
  - 点击单词区触发 `speechSynthesis` 朗读（人工听或在 console 验证 `speak` 调用）。
- 视觉回归为人工核对（项目无视觉测试基建）。

## 不在本期范围

- 音标（IPA）文字及其数据来源。
- 例句区朗读、拼写卡朗读按钮。
- 完成页 / 首页 / 家长端字号。
- 视觉风格 / 配色 / 品牌重塑。
