# Spelling Input: Block iOS Autocomplete / Prediction Bar

## Purpose
Stop the iOS / iPadOS keyboard's predictive bar from leaking the answer during the spelling test. Today, when a kid types `bo`, the keyboard suggests `book`, `boy`, `both` directly above the keys; the kid taps `book` and the answer is handed over, defeating the spelling practice. The current `<input>` already carries `autocapitalize="none" autocomplete="off" spellcheck="false"`, but iOS ignores these for `type="text"` and still shows the suggestion bar.

## Background — Why Attributes Alone Are Not Enough
iOS Safari decides whether to show the predictive / autocorrect bar based primarily on the input element's `type`. For `type="text"` the bar appears regardless of `autocomplete="off"` / `autocorrect="off"` on most iOS versions. Apple reserves truly prediction-free behavior for `type="password"` (and a few other non-text types). There is no DOM API to hide the bar directly; the only reliable lever is the input `type`.

Tapping a suggestion commits via an `InputEvent` whose `inputType === "insertReplacementText"`. That gives us a second, JS-level defense layer.

## Proposed Change — Three-Layer Defense

Replace the single `<input>` inside `spellingCard(w)` (`public/app.js`) with a wrapper containing a visible **mirror div** plus a hidden **`type="password"` input**:

### Layer 1 — `type="password"` (root cause fix)
iOS does not show the predictive / autocorrect bar for password inputs. The input's value is still fully readable from JS (`.value`), so we can mirror it visibly. The password dots are never shown to the user because the input itself is rendered transparent.

### Layer 2 — JS guard against replacement-style inserts (fallback)
An `input` event listener rejects any insert whose `inputType` is one of:
- `insertReplacementText` (iOS autocorrect / suggestion tap)
- `insertFromPaste` (paste the answer)
- `insertFromDrop` (drag-drop)

On rejection, the listener restores the previous value (`last` snapshot).

### Layer 3 — non-ASCII strip (catch-all)
After every accepted input, the value is sanitized to `[a-zA-Z'-]`. This neutralizes Chinese IME commits and emoji without rejecting `insertCompositionText` mid-composition (rejecting that breaks IME state machines). It also preserves apostrophes / hyphens for words like `don't` and `mother-in-law`.

## Component Design

### HTML structure (inside `spellingCard`, replaces current line 119)
```html
<div class="spell-input">
  <div class="spell-mirror" id="mirror"></div>
  <input type="password" id="ans"
         autocorrect="off" autocapitalize="off" autocomplete="off"
         spellcheck="false" inputmode="text"
         aria-label="拼写英文单词" />
</div>
```
- Mirror is on top (z-index), receives taps → `input.focus()`.
- Input sits underneath with `color: transparent; caret-color: transparent;` — keyboard still targets it, nothing visible.
- Mirror renders **only the characters typed so far + a blinking caret**, with **no fixed-width slots** — preset slots would leak the answer length, which the original input also did not.

### CSS (`public/style.css`)
- `.spell-input` reuses the current `.study input` border / radius / padding so the visual footprint is unchanged.
- `.spell-mirror`: same font-family / font-size / padding as `.study input` (22px mobile, 24px ≥1024px — piggybacks on existing responsive rule), left-aligned.
- `.caret`: `display:inline-block; width:2px; height:1em; background:var(--pri); vertical-align:-2px;` with a 1s blink `@keyframes`.
- `.spell-mirror .ph`: placeholder color (`#9ca3af`).
- Focus feedback: when `#ans` is focused, `.spell-mirror` gets a highlighted border (since the input itself has no visible focus ring).
- Responsive: font-size tracks the existing `.study input` rule — no new breakpoint needed.

### JS (`public/app.js`)
A new `makeSpellInput(input, mirror, placeholder)` helper (defined in `app.js`, since it touches the DOM) wires up the three layers via the imported pure helpers and renders the mirror:

```js
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

`spellingCard` integration (replaces lines ~119–128):
```js
const inp = card.querySelector("#ans");
const mirror = card.querySelector("#mirror");
makeSpellInput(inp, mirror, "拼写英文单词");
inp.focus();
```
Submit logic (`inp.value.trim().toLowerCase()` compare, Enter-to-submit, double-submit guard) is **unchanged**.

## Edge Cases & Error Handling
| Scenario | Handling |
|---|---|
| Chinese pinyin IME commits Chinese chars | `[^a-zA-Z'-]` strip removes them; `insertCompositionText` is NOT rejected mid-composition so the IME doesn't break |
| Kid pastes the answer | `paste` event `preventDefault`, plus `insertFromPaste` rollback as backup |
| Backspace / delete | Native input behavior; mirror re-renders from `input.value` automatically |
| Words with `'` or `-` (`don't`, `mother-in-law`) | Whitelisted in the sanitizer; `toLowerCase()` compare unchanged |
| Caps lock (`BOOK`) | Mirror shows uppercase as-is; submit lowercases — same as before |
| iPad landscape | Font-size follows existing `.study input` responsive rule |
| Input invisible → no tap target | Mirror div is full-width and tappable → focuses the input |
| Post-submit blur | Irrelevant — card resolves; next card rebuilds from scratch |

## Testing — First Frontend Unit Test in This Repo
The three pure helpers (`shouldRejectInputType`, `sanitizeValue`, `renderMirrorHtml`) are extracted to a new `public/spell-helpers.js` ES module so they can be imported by both the browser and vitest. `app.js` becomes `type="module"` and imports them.

**Why this matters:** the dev machine is Linux; iOS on-device verification is not possible here. The JS guard's contract ("these `inputType`s get rejected, everything else passes through") is exactly the kind of pure-logic predicate that should be unit-tested so we have confidence without a device.

### New / changed files
- `public/spell-helpers.js` (new) — `export function shouldRejectInputType(t)`, `sanitizeValue(v)`, `renderMirrorHtml(v, placeholder)`.
- `public/app.js` — add `import { shouldRejectInputType, sanitizeValue, renderMirrorHtml } from "./spell-helpers.js"`; define `makeSpellInput` locally (it touches DOM, so it stays in `app.js` and calls the three imported pure helpers). `spell-helpers.js` exports its own tiny `escapeHtml` (used by `renderMirrorHtml`) so the module is self-contained and pure; `app.js` keeps its existing top-of-file `escapeHtml` untouched to avoid churning unrelated call sites (identity, home, etc.).
- `public/index.html` — change `<script src="/app.js">` to `<script type="module" src="/app.js">`.
- `test/spell-helpers.test.ts` (new) — table-driven assertions for the three pure functions.
- `public/style.css` — add `.spell-input`, `.spell-mirror`, `.caret`, `.spell-mirror .ph`, focus border.

### Test cases to cover
- `shouldRejectInputType`: `insertReplacementText` / `insertFromPaste` / `insertFromDrop` → true; `insertText` / `deleteContentBackward` / `insertCompositionText` / undefined → false.
- `sanitizeValue`: `"book"` → `"book"`; `"bo你好ok"` → `"book"`; `"don't"` → `"don't"`; `"MOTHER-IN-LAW"` → `"MOTHER-IN-LAW"`; `"a b c"` → `"abc"` (spaces stripped); `"🎉book"` → `"book"`.
- `renderMirrorHtml`: non-empty value escapes HTML and appends caret; empty value returns placeholder + caret; HTML-special chars (`<`, `&`) in value are escaped.

## Alternatives Considered
- **Attribute stack only** (`autocorrect=off` etc.): rejected — iOS ignores these for `type="text"`; the predictive bar still appears.
- **Switch to letter-tile / anagram UI**: rejected by user — keep typing input, lower disruption for older kids.
- **Hidden input + fully custom display (Approach C in brainstorm)**: rejected as over-engineering — would require simulating selection / cursor / delete; the password-type + thin mirror achieves the same anti-leak with ~20 lines.
- **Reject `insertCompositionText`**: rejected — breaks IME state machines; the non-ASCII strip on accepted input achieves the same effect more safely.

## Scope
**In scope:**
- The single spelling input in `spellingCard` (`public/app.js`).
- CSS for `.spell-input` / `.spell-mirror` / `.caret` / placeholder / focus.
- New `public/spell-helpers.js` ES module + `test/spell-helpers.test.ts`.
- `index.html` script tag → `type="module"`.

**Out of scope:**
- Admin / identity / home screens (no spelling input there).
- Letter-tile / anagram alt UI (deferred; could be a future setting).
- Server-side changes (`/review`, `/session/*` unaffected — submit payload identical).
- Refactoring the rest of `app.js` into modules (only the new helper is modularized).

## Implementation Plan (high level)
1. Create `public/spell-helpers.js` exporting the 3 pure helpers + a local `escapeHtml`.
2. Write `test/spell-helpers.test.ts`; run `npm test` to confirm green.
3. In `public/app.js`: import helpers, add `makeSpellInput`, replace the `<input>` block in `spellingCard`, keep submit logic intact.
4. Update `public/index.html`: `<script type="module" src="/app.js">`.
5. Add CSS rules to `public/style.css`.
6. Manual smoke check via `wrangler dev` (desktop browser): type, backspace, paste-blocked, apostrophe word, caps lock, Enter submit, focus ring on mirror.
7. Commit.
