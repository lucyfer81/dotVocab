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
  // Allow single spaces (phrases like "ice cream"); collapse runs of
  // whitespace to one space and drop leading ones. Trailing space is kept
  // so typing continues naturally; final trim happens at submit.
  return v.replace(/[^a-zA-Z' -]/g, "").replace(/\s+/g, " ").replace(/^ +/, "");
}

export function renderMirrorHtml(v, placeholder) {
  if (v) return escapeHtml(v) + '<i class="caret"></i>';
  return `<span class="ph">${escapeHtml(placeholder)}</span><i class="caret"></i>`;
}

// Compare the expected answer with what the kid typed. Matching letters are
// ok, wrong/missing ones bad, and anything typed beyond the answer length is
// shown struck-through instead of being silently dropped.
export function diffHtml(answer, given) {
  let out = "";
  for (let i = 0; i < answer.length; i++) {
    const a = answer[i], g = given[i] || "";
    out += g === a ? `<b class="ok">${escapeHtml(a)}</b>` : `<b class="bad">${escapeHtml(a)}</b>`;
  }
  if (given.length > answer.length) {
    out += `<b class="bad extra">${escapeHtml(given.slice(answer.length))}</b>`;
  }
  return out;
}
