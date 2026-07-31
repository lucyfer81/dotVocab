# 背单词卡片字号与布局重做 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把孩子端「新词介绍卡」的单词/中文释义/🔊 从 ~16px 裸文字放大成可读的居中卡片（整词可点即读），并让「拼写卡」套用同一套字号与卡片框。

**Architecture:** 纯前端。新增 `.wordcard` 卡片框样式（原 class 是空的）、`.tap-word` 可点即读区、统一 `.meaning` 字号；在既有 `@media(min-width:1024px)` 断点内上一档并给卡片 `max-width:480px` 居中。`app.js` 仅改 `showWordIntro` 与 `spellingCard` 两处模板字符串。零后端 / 数据改动。

**Tech Stack:** vanilla JS（无构建）、单 `public/style.css`、Cloudflare Workers + D1 后端（本期不动）、vitest + @cloudflare/vitest-pool-workers（后端回归）、Playwright（视觉人工核对）。

**对应 spec:** `docs/superpowers/specs/2026-07-31-recite-card-type-scale-design.md`

---

## 验证策略说明（偏离纯 TDD 的原因）

孩子端是 vanilla JS，**无 JS/DOM 单测基建**；仓库 32 个测试全是后端（vitest + cloudflare pool）。spec 明确视觉验证为人工 Playwright。因此每个任务用以下自动化检查代替单测，符合仓库已有的「结构不变式冒烟」做法：

- `node --check public/app.js` —— 改完模板字符串后确认无语法错误（无输出即成功）。
- 结构 grep 不变式 —— 确认新 class 落地、旧模式清除。
- `npm test` —— 全流程末尾跑一次，确认 32 个后端测试仍全绿（回归兜底）。
- Playwright 视觉核对 —— 末任务对 `wrangler dev` 起的本地服务在 390 / 1024 / 1194 三档截图。

---

## Task 1: `style.css` — 落实 `.wordcard` 卡片框、`.tap-word` 可点区、统一字号

**Files:**
- Modify: `public/style.css`（默认段第 20 行删 `.meaning.big`；第 24 行后新增规则块；iPad 段第 39 行删 `.meaning.big`、第 42 行后新增规则）

- [ ] **Step 1: 删除默认段的 `.meaning.big` 规则**

在 `public/style.css` 找到这一行并整行删除：

```css
.meaning.big { font-size:24px; margin:10px 0; }
```

（拼写卡标记将在 Task 3 改为不带 `big`；此处先删规则，期间拼写卡释义回落到新增的 `.meaning{26px}`，与目标一致，无回归。）

- [ ] **Step 2: 在默认段新增卡片框 / 可点区 / 字号规则**

定位到默认段这条规则（紧接 `.ex` 之后）：

```css
.fb { min-height:32px; margin:8px 0; font-size:20px; }
```

在它**前面**插入以下整块：

```css
/* ---- 背单词卡片：卡片框 + 整词可点 + 统一字号（2026-07-31） ---- */
.wordcard { background:#fff; border-radius:18px; padding:24px 22px; margin:8px 0; box-shadow:0 2px 10px rgba(0,0,0,.05); text-align:center; }
.tap-word { display:block; width:100%; border:0; background:#f0f7ff; border-radius:12px; padding:12px 8px; cursor:pointer; text-align:center; color:#1e3a8a; }
.tap-word .term { font-size:40px; font-weight:700; line-height:1.15; }
.tap-word .audio-hint { font-size:30px; margin-left:6px; }
.tap-word .tap-hint { display:block; font-size:12px; color:#9ca3af; margin-top:4px; }
.meaning { font-size:26px; line-height:1.3; margin-top:16px; }
.meaning .pos { font-size:15px; color:#9ca3af; margin-right:4px; }
.wordcard .ex { font-size:17px; margin-top:12px; }
.wordcard .ex .muted { font-size:15px; }

```

- [ ] **Step 3: 在 iPad 段删除 `.meaning.big` 并新增放大规则**

在 `@media (min-width: 1024px) { ... }` 块内，删除这一行：

```css
  .meaning.big { font-size: 32px; }
```

然后定位到 iPad 段这条（作为锚点）：

```css
  .study input { max-width: 480px; }
```

在它**后面**插入：

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

- [ ] **Step 4: grep 不变式核对**

Run:
```bash
grep -n "meaning.big" public/style.css public/app.js
grep -n "tap-word\|wordcard" public/style.css
```
Expected: 第一条**无输出**（`.meaning.big` 已全清）；第二条能看到默认段 + iPad 段的 `.wordcard`/`.tap-word` 规则。

- [ ] **Step 5: 提交**

```bash
git add public/style.css
git commit -m "style(py): 落实 .wordcard 卡片框与背单词统一字号

新增 .tap-word 整词可点区、.wordcard 白底卡片框、.meaning 统一字号
（默认 26px / iPad 32px），单词 .term 40/56px。删除已废弃的 .meaning.big。
iPad 段卡片 max-width:480px 居中。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: `app.js` — `showWordIntro` 改为整词可点即读

**Files:**
- Modify: `public/app.js:104-113`（`showWordIntro` 的模板与 `#play` 处理器）

- [ ] **Step 1: 替换介绍卡模板**

把 `public/app.js` 中这段：

```js
      const card = $(`<section class="study">
        <h2>${escapeHtml(title || "今日复习")}</h2>
        <div class="wordcard">
          <div class="term">${escapeHtml(w.term)} <button class="link" id="play">🔊</button></div>
          <div class="meaning">${escapeHtml(w.pos ? w.pos + ". " : "")}${escapeHtml(w.meaning_cn)}</div>
          ${w.example_en ? `<div class="ex">${escapeHtml(w.example_en)}<br><span class="muted">${escapeHtml(w.example_cn || "")}</span></div>` : ""}
        </div>
        <button class="big" id="start">开始拼写</button>
      </section>`);
      card.querySelector("#play").onclick = () => speak(w.term);
```

整体替换为：

```js
      const card = $(`<section class="study">
        <h2>${escapeHtml(title || "今日复习")}</h2>
        <div class="wordcard">
          <button class="tap-word" id="play" aria-label="朗读单词">
            <span class="term">${escapeHtml(w.term)}</span><span class="audio-hint">🔊</span>
            <small class="tap-hint">点单词朗读</small>
          </button>
          <div class="meaning">${w.pos ? `<span class="pos">${escapeHtml(w.pos)}.</span>` : ""}${escapeHtml(w.meaning_cn)}</div>
          ${w.example_en ? `<div class="ex">${escapeHtml(w.example_en)}<br><span class="muted">${escapeHtml(w.example_cn || "")}</span></div>` : ""}
        </div>
        <button class="big" id="start">开始拼写</button>
      </section>`);
      card.querySelector("#play").onclick = () => speak(w.term);
```

要点：
- `#play` 由单独的 `.link` 小按钮变为整词 `<button class="tap-word">`，`onclick` 处理器不变（`speak(w.term)`）。
- 词性 `pos` 改用 `<span class="pos">` 以套用小一号灰色样式。
- `escapeHtml(...)` 对 `w.term` / `w.pos` / `w.meaning_cn` / 例句的包裹全部保留。

- [ ] **Step 2: 语法核对**

Run: `node --check public/app.js`
Expected: 无输出（语法正确）。

- [ ] **Step 3: grep 不变式核对**

Run:
```bash
grep -n 'class="tap-word"' public/app.js
grep -n 'class="link" id="play"' public/app.js
```
Expected: 第一条命中 1 处；第二条**无输出**（旧的小喇叭链接按钮已移除）。

- [ ] **Step 4: 提交**

```bash
git add public/app.js
git commit -m "feat(py): 介绍卡单词改为整词可点即读

单词 + 🔊 包成 .tap-word 按钮，点击触发 speak(term)；🔊 仅作提示。
词性改用 .pos span。移除旧的 .link 小喇叭按钮。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: `app.js` — `spellingCard` 套用 `.wordcard` 并对齐字号体系

**Files:**
- Modify: `public/app.js:121-129`（`spellingCard` 的模板）

- [ ] **Step 1: 替换拼写卡模板**

把 `public/app.js` 中这段：

```js
      const card = $(`<section class="study">
        <h2>${escapeHtml(title || "今日复习")}</h2>
        <div class="progress"><i id="bar"></i></div>
        <div class="meaning big">${escapeHtml(w.pos ? w.pos + ". " : "")}${escapeHtml(w.meaning_cn)}</div>
        ${w.example_en ? `<div class="ex">${escapeHtml(w.example_en)}</div>` : ""}
        <input id="ans" autocapitalize="none" autocomplete="off" spellcheck="false" placeholder="拼写英文单词" />
        <div id="fb" class="fb"></div>
        <button class="big" id="submit">提交</button>
      </section>`);
```

整体替换为：

```js
      const card = $(`<section class="study">
        <h2>${escapeHtml(title || "今日复习")}</h2>
        <div class="progress"><i id="bar"></i></div>
        <div class="wordcard">
          <div class="meaning">${w.pos ? `<span class="pos">${escapeHtml(w.pos)}.</span>` : ""}${escapeHtml(w.meaning_cn)}</div>
          ${w.example_en ? `<div class="ex">${escapeHtml(w.example_en)}</div>` : ""}
        </div>
        <input id="ans" autocapitalize="none" autocomplete="off" spellcheck="false" placeholder="拼写英文单词" />
        <div id="fb" class="fb"></div>
        <button class="big" id="submit">提交</button>
      </section>`);
```

要点：
- 释义行 `meaning big` → `meaning`（Task 1 已把字号统一到 `.meaning`）。
- 释义 + 例句包进 `.wordcard` 白卡片框，与介绍卡一致。
- 词性改用 `<span class="pos">`。`escapeHtml` 保留。

- [ ] **Step 2: 语法核对**

Run: `node --check public/app.js`
Expected: 无输出。

- [ ] **Step 3: grep 不变式核对**

Run:
```bash
grep -n 'meaning big' public/app.js
grep -c 'class="wordcard"' public/app.js
```
Expected: 第一条**无输出**；第二条输出 `2`（介绍卡 + 拼写卡都用上卡片框）。

- [ ] **Step 4: 提交**

```bash
git add public/app.js
git commit -m "feat(py): 拼写卡套用 .wordcard 与统一字号

释义 .meaning.big → .meaning 并与例句一同纳入 .wordcard 卡片框，
和介绍卡视觉连贯。词性改用 .pos span。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 回归与视觉核对

**Files:** 无（仅验证）

- [ ] **Step 1: 后端回归**

Run: `npm test`
Expected: 32 个测试全绿（本期零后端改动，纯兜底）。

- [ ] **Step 2: 起本地服务**

Run（后台）: `wrangler dev`
Expected: 监听 `http://localhost:8787`。> 注：本机有 127.0.0.1:1081 代理，`curl` 须加 `--noproxy '*'`；浏览器（Playwright）直连 localhost 一般不受影响。

- [ ] **Step 3: Playwright 视觉核对（手机 390×844）**

用 Playwright MCP：
1. `browser_resize` 至 390×844。
2. `browser_navigate` `http://localhost:8787`。
3. 用 `browser_snapshot` 找到「哥哥」头像 → `browser_click` 进入首页 → 点任一单元卡 → 进入新词介绍卡。
4. `browser_take_screenshot`（type png）。
5. 核对：单词 ~40px、释义 ~26px、白卡片框、🔊 在词右侧、"点单词朗读"提示。
6. `browser_click` 单词区 → 确认触发朗读（人工听或在 console `browser_evaluate` 验证 `speechSynthesis.speaking`）。
7. 点「开始拼写」进拼写卡 → 截图，核对释义 26px + 同款卡片框。

Expected: 介绍卡/拼写卡均放大、有卡片框；点击单词触发朗读。

- [ ] **Step 4: Playwright 视觉核对（iPad 横版 1024×768 与 1194×834）**

`browser_resize` 分别至 1024×768、1194×834，重复 Step 3 的导航与截图。
Expected: 单词 ~56px、释义 ~32px、卡片收窄至 ~480px 居中，不散开。

- [ ] **Step 5: 手机端回归基准（确认非学习页未被波及）**

在 390×844 下回到首页与身份页截图，与改动前对比。
Expected: 首页 / 身份页 / 单元网格视觉无变化（新规则只作用于 `.wordcard`/`.tap-word`/`.meaning`，这些仅出现在学习卡）。

- [ ] **Step 6: 关停本地服务**

`TaskStop` 停掉 `wrangler dev` 后台进程。

> 若 Step 3–5 发现任何视觉问题，回到对应 Task 修 `style.css`/`app.js` 并重新核对，无误后才算完成。本任务不产生新提交（除非修了 bug）。
