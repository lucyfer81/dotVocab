# Spelling Input Anti-Autocomplete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop iOS / iPadOS from leaking the spelling answer via the keyboard's predictive bar by switching the spelling input to a `type="password"` real input + visible mirror div, backed by a JS guard and non-ASCII sanitizer.

**Architecture:** Three defense layers — (1) `type="password"` so iOS does not render the predictive bar at all; (2) a JS `input` listener that rolls back `insertReplacementText` / `insertFromPaste` / `insertFromDrop` events; (3) a non-ASCII strip that catches Chinese IME commits and emoji. A visible mirror `<div>` renders the typed letters (since the password field shows dots), and is the tap target that focuses the hidden input.

**Tech Stack:** Vanilla JS (ES module), Hono on Cloudflare Workers, vitest with `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-08-03-spell-input-anti-autocomplete-design.md`

## Global Constraints
- Pure helpers MUST have zero DOM dependencies (so they run under the workers vitest pool).
- Submit / SRS / Enter-key / double-submit-guard logic in `spellingCard` is unchanged — the answer still comes from `inp.value.trim().toLowerCase()`.
- Mirror MUST NOT reveal answer length (no fixed-width slots) — matches original input's behavior.
- Sanitizer whitelist is exactly `[a-zA-Z'-]` (apostrophe + hyphen for words like `don't`, `mother-in-law`).
- No refactor of unrelated `app.js` code (identity / home / admin screens untouched).
- App.js stays a single file; only the new helpers are extracted to a sibling module.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `public/spell-helpers.js` | Create | Pure, DOM-free helpers: `escapeHtml`, `shouldRejectInputType`, `sanitizeValue`, `renderMirrorHtml`. Exported as ES module. |
| `test/spell-helpers.test.ts` | Create | Table-driven unit tests for the three exported helpers (first frontend unit test in repo). |
| `public/app.js` | Modify | Import the three helpers; add `makeSpellInput(input, mirror, placeholder)` DOM-wiring; replace the `<input>` block inside `spellingCard`. |
| `public/index.html` | Modify | Change `<script src="/app.js">` → `<script type="module" src="/app.js">`. |
| `public/style.css` | Modify | Add `.spell-input`, `.spell-mirror`, `.caret`, `.ph`, transparent input text, focus highlight, responsive font-size. |

---

## Task 1: Pure Helpers + Unit Tests (TDD)

**Files:**
- Create: `public/spell-helpers.js`
- Test: `test/spell-helpers.test.ts`

**Interfaces:**
- Produces (consumed by Task 2):
  - `shouldRejectInputType(t: string | undefined): boolean`
  - `sanitizeValue(v: string): string`
  - `renderMirrorHtml(v: string, placeholder: string): string`
  - (`escapeHtml` is internal to this module — not imported by `app.js`.)

- [ ] **Step 1: Write the failing test**

Create `test/spell-helpers.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { shouldRejectInputType, sanitizeValue, renderMirrorHtml } from "../public/spell-helpers.js";

describe("shouldRejectInputType", () => {
  it("rejects replacement-style inserts (iOS autocorrect, paste, drop)", () => {
    expect(shouldRejectInputType("insertReplacementText")).toBe(true);
    expect(shouldRejectInputType("insertFromPaste")).toBe(true);
    expect(shouldRejectInputType("insertFromDrop")).toBe(true);
  });
  it("allows normal typing, deletion, and IME composition", () => {
    expect(shouldRejectInputType("insertText")).toBe(false);
    expect(shouldRejectInputType("deleteContentBackward")).toBe(false);
    expect(shouldRejectInputType("insertCompositionText")).toBe(false);
  });
  it("handles undefined inputType (some browsers omit it)", () => {
    expect(shouldRejectInputType(undefined)).toBe(false);
  });
});

describe("sanitizeValue", () => {
  it("keeps ascii letters as-is", () => {
    expect(sanitizeValue("book")).toBe("book");
  });
  it("strips non-ascii chars (chinese IME commit)", () => {
    expect(sanitizeValue("bo你好ok")).toBe("book");
  });
  it("keeps apostrophe and hyphen", () => {
    expect(sanitizeValue("don't")).toBe("don't");
    expect(sanitizeValue("mother-in-law")).toBe("mother-in-law");
  });
  it("preserves case (lowercasing happens at submit, not here)", () => {
    expect(sanitizeValue("MOTHER-IN-LAW")).toBe("MOTHER-IN-LAW");
  });
  it("strips whitespace", () => {
    expect(sanitizeValue("a b c")).toBe("abc");
  });
  it("strips emoji", () => {
    expect(sanitizeValue("🎉book")).toBe("book");
  });
});

describe("renderMirrorHtml", () => {
  it("renders value + blinking caret when non-empty", () => {
    expect(renderMirrorHtml("bo", "拼写英文单词")).toBe(`bo<i class="caret"></i>`);
  });
  it("renders placeholder + caret when empty", () => {
    expect(renderMirrorHtml("", "拼写英文单词")).toBe(`<span class="ph">拼写英文单词</span><i class="caret"></i>`);
  });
  it("escapes html-special chars in value (defense in depth)", () => {
    expect(renderMirrorHtml("<b>&", "p")).toBe(`&lt;b&gt;&amp;<i class="caret"></i>`);
  });
  it("escapes html-special chars in placeholder", () => {
    expect(renderMirrorHtml("", `<x>`)).toBe(`<span class="ph">&lt;x&gt;</span><i class="caret"></i>`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/spell-helpers.test.ts`
Expected: FAIL — error resolving `../public/spell-helpers.js` (file does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `public/spell-helpers.js`:
```js
// Pure helpers for the spelling input. No DOM dependencies — safe to unit-test
// under the vitest workers pool. Imported by app.js (browser) and the test.
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

export function shouldRejectInputType(t) {
  return t === "insertReplacementText"
      || t === "insertFromPaste"
      || t === "insertFromDrop";
}

export function sanitizeValue(v) {
  return v.replace(/[^a-zA-Z'-]/g, "");
}

export function renderMirrorHtml(v, placeholder) {
  if (v) return escapeHtml(v) + '<i class="caret"></i>';
  return `<span class="ph">${escapeHtml(placeholder)}</span><i class="caret"></i>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/spell-helpers.test.ts`
Expected: PASS — all 13 assertions green.

- [ ] **Step 5: Run full suite to confirm no regressions**

Run: `npm test`
Expected: all existing tests (`api`, `csv`, `srs`, `tts`) + the new `spell-helpers` test pass.

- [ ] **Step 6: Commit**

```bash
git add public/spell-helpers.js test/spell-helpers.test.ts
git commit -m "feat(spell): 纯函数 shouldRejectInputType/sanitizeValue/renderMirrorHtml + 单测"
```

---

## Task 2: Wire Mirror Input into spellingCard + CSS + Module Load

**Files:**
- Modify: `public/app.js` (top import, new `makeSpellInput` fn, replace input block in `spellingCard` ~line 119, add mirror lookup)
- Modify: `public/index.html` (script tag → `type="module"`)
- Modify: `public/style.css` (new rules for `.spell-input` / `.spell-mirror` / `.caret` / `.ph` / transparent input / focus / responsive)

**Interfaces:**
- Consumes (from Task 1): `shouldRejectInputType`, `sanitizeValue`, `renderMirrorHtml` — imported from `./spell-helpers.js`.
- Produces: working spelling card with iOS predictive bar suppressed; unchanged submit payload to `/api/review`.

- [ ] **Step 1: Add the module import to app.js**

In `public/app.js`, replace line 1 (`const API = "/api";`) with:
```js
import { shouldRejectInputType, sanitizeValue, renderMirrorHtml } from "./spell-helpers.js";

const API = "/api";
```

- [ ] **Step 2: Add `makeSpellInput` helper to app.js**

In `public/app.js`, immediately after the existing `escapeHtml` function (currently ends around line 40), add:
```js
// ---------- spell input: password field + mirror display ----------
// iOS does not show the predictive bar for type=password; the mirror div is
// what the user actually sees, since password dots would be useless here.
function makeSpellInput(input, mirror, placeholder) {
  let last = "";
  const render = () => { mirror.innerHTML = renderMirrorHtml(input.value, placeholder); };
  input.addEventListener("input", (e) => {
    if (shouldRejectInputType(e.inputType)) { input.value = last; return; }
    const cleaned = sanitizeValue(input.value);
    if (cleaned !== input.value) input.value = cleaned;
    last = input.value;
    render();
  });
  input.addEventListener("paste", (e) => e.preventDefault());
  mirror.addEventListener("click", () => input.focus());
  render();
  return { render };
}
```

- [ ] **Step 3: Replace the input block inside `spellingCard`**

In `public/app.js`, inside the `spellingCard(w)` template literal, find this line:
```js
        <input id="ans" autocapitalize="none" autocomplete="off" spellcheck="false" placeholder="拼写英文单词" />
```
Replace it with:
```js
        <div class="spell-input">
          <div class="spell-mirror" id="mirror"></div>
          <input type="password" id="ans"
                 autocorrect="off" autocapitalize="off" autocomplete="off"
                 spellcheck="false" inputmode="text"
                 aria-label="拼写英文单词" />
        </div>
```

- [ ] **Step 4: Wire `makeSpellInput` into the card**

In `public/app.js`, inside `spellingCard`, find:
```js
      const inp = card.querySelector("#ans"); inp.focus();
```
Replace with:
```js
      const inp = card.querySelector("#ans");
      const mirror = card.querySelector("#mirror");
      makeSpellInput(inp, mirror, "拼写英文单词");
      inp.focus();
```
(Leave the `submit`, Enter-key handler, and double-submit guard below it untouched.)

- [ ] **Step 5: Update index.html script tag**

In `public/index.html`, change:
```html
  <script src="/app.js"></script>
```
to:
```html
  <script type="module" src="/app.js"></script>
```

- [ ] **Step 6: Add CSS rules to style.css**

Append to `public/style.css` (after the existing `.progress` rule, before the `@media (min-width: 1024px)` block):
```css
/* ---- 拼写输入：password 真 input + 镜像显示（防 iOS 联想栏, 2026-08-03） ---- */
.spell-input { position: relative; }
.spell-mirror {
  position: absolute; top: 0; left: 0; right: 0; bottom: 0;
  display: flex; align-items: center;
  padding: 14px;                       /* 与 .study input 同 */
  font-family: inherit;
  font-size: 22px;                     /* 与 .study input mobile 同 */
  color: var(--ink);
  cursor: text;
  z-index: 1;
  overflow: hidden;
}
.spell-mirror .ph { color: #9ca3af; }
.spell-mirror .caret {
  display: inline-block; width: 2px; height: 1.2em; margin-left: 1px;
  background: var(--pri);
  animation: spell-caret-blink 1s steps(2, start) infinite;
}
@keyframes spell-caret-blink { to { opacity: 0; } }

/* 真 input：文字/光标透明，仅接收键盘；边框/圆角/padding 仍由 .study input 提供 */
.spell-input input {
  color: transparent;
  caret-color: transparent;
  position: relative;
  z-index: 0;
}
.spell-input:focus-within input { border-color: var(--pri); }   /* input 透明看不到 focus ring，靠边框变色提示 */
```

Then, inside the existing `@media (min-width: 1024px) { ... }` block, add this line (e.g. right after `.study input { font-size:24px; }`):
```css
  .spell-mirror { font-size: 24px; }   /* 与 .study input ≥1024 同步 */
```

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: all tests still pass (no test covers the DOM wiring, but the pure-helper tests from Task 1 must remain green).

- [ ] **Step 8: Manual smoke test in browser**

Run: `npm run dev` (wrangler dev), open the local URL.

For each scenario, start a spelling session (pick a unit with unseen words, or use due review) and verify:
1. **Mirror renders typed letters** — type `b`, `o`, `o`, `k`; the mirror shows `book` with a blinking caret at the end. The password input below shows nothing (transparent).
2. **Placeholder when empty** — on a fresh card, mirror shows the faint「拼写英文单词」placeholder + blinking caret.
3. **Tap mirror to focus** — tap anywhere on the mirror; keyboard appears, input gains focus (border turns blue).
4. **Backspace works** — type `boo`, backspace twice; mirror re-renders to `b`.
5. **Submit on Enter still works** — type the answer, press Enter; card advances.
6. **Paste blocked** — copy a word from elsewhere, try pasting into the input; nothing is inserted.
7. **Apostrophe word** — if a word like `don't` comes up, the apostrophe is accepted (or test by typing `don'` — the `'` survives sanitize).
8. **Caps lock** — type in uppercase; mirror shows uppercase; submit still marks correct (lowercase compare).
9. **Wrong-answer feedback still works** — type a wrong word, submit; the diff view and「下一题」button render as before.
10. **iPad-width responsive (≥1024px)** — resize browser to ≥1024px wide; mirror font-size becomes 24px, matching the input.

- [ ] **Step 9: Commit**

```bash
git add public/app.js public/index.html public/style.css
git commit -m "feat(spell): password input + 镜像显示,堵 iOS 联想栏与粘贴"
```

---

## Self-Review Notes

**Spec coverage:** all five spec sections map to tasks:
- §1 HTML structure → Task 2 Step 3.
- §2 CSS / visual → Task 2 Step 6 (incl. responsive font-size + focus highlight).
- §3 JS logic (`makeSpellInput` + three-layer defense) → Task 2 Step 2 (wiring) + Task 1 (pure helpers).
- §4 Edge cases → covered by Task 1 tests (IME strip, paste rejection) and Task 2 Step 8 smoke (backspace, caps, apostrophe, paste).
- §5 Testing → Task 1 in full.

**Placeholder scan:** none — every step carries concrete code or a concrete shell command.

**Type consistency:** helper signatures (`shouldRejectInputType(t)`, `sanitizeValue(v)`, `renderMirrorHtml(v, placeholder)`) match across Task 1 implementation, Task 1 tests, and Task 2 import + `makeSpellInput` call sites. Mirror HTML class names (`.caret`, `.ph`) match between `renderMirrorHtml` output (Task 1) and CSS rules (Task 2 Step 6). Element ids (`#ans`, `#mirror`) match between HTML (Task 2 Step 3) and JS lookup (Task 2 Step 4).

**Scope check:** single focused change, two tasks, no sub-project decomposition needed.
