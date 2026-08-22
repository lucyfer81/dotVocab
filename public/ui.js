// App-native dialogs and toasts: replaces window.confirm / window.alert so
// kids and parents never see the unstyled browser popups.
// Pure HTML builders (confirmHtml/toastHtml) are unit-tested in test/ui.test.ts;
// showConfirm/showToast wire them into the DOM.
import { escapeHtml } from "./spell-helpers.js";

export function confirmHtml({ title, message, okText = "确定", cancelText = "取消", danger = false }) {
  return `<div class="modal-root" role="dialog" aria-modal="true">
    <div class="modal-mask"></div>
    <div class="modal-card">
      <h3 class="modal-title">${escapeHtml(title)}</h3>
      <p class="modal-msg">${escapeHtml(message)}</p>
      <div class="modal-btns">
        <button class="big modal-cancel">${escapeHtml(cancelText)}</button>
        <button class="big modal-ok${danger ? " danger" : ""}">${escapeHtml(okText)}</button>
      </div>
    </div>
  </div>`;
}

export function toastHtml(message, kind = "info") {
  return `<div class="toast ${kind}" role="status">${escapeHtml(message)}</div>`;
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// Promise-based in-app replacement for window.confirm().
// Escape / mask click / cancel button all resolve false; ok resolves true.
export function showConfirm(opts) {
  return new Promise((resolve) => {
    const root = el(confirmHtml(opts));
    const done = (v) => {
      document.removeEventListener("keydown", onKey);
      root.remove();
      resolve(v);
    };
    const onKey = (e) => { if (e.key === "Escape") done(false); };
    root.querySelector(".modal-ok").onclick = () => done(true);
    root.querySelector(".modal-cancel").onclick = () => done(false);
    root.querySelector(".modal-mask").onclick = () => done(false);
    document.addEventListener("keydown", onKey);
    document.body.appendChild(root);
    // focus the safe choice: Enter keeps the kid in the session / keeps the word alive
    root.querySelector(".modal-cancel").focus();
  });
}

// In-app replacement for window.alert(): transient, non-blocking.
export function showToast(message, kind = "info") {
  const t = el(toastHtml(message, kind));
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}
