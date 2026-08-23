import { shouldRejectInputType, sanitizeValue, renderMirrorHtml, diffHtml } from "./spell-helpers.js";
import { sfx } from "./sfx.js";
import { showConfirm, showToast } from "./ui.js";
import { createTtsPlayer } from "./tts-player.js";
import { recordAnswer } from "./review-client.js";

const API = "/api";
let currentUser;
try { currentUser = JSON.parse(localStorage.getItem("dotvocab_user") || "null"); }
catch { currentUser = null; }

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "请求失败");
  return res.json();
}
function $(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function render(node) {
  const app = document.getElementById("app");
  app.innerHTML = "";
  app.appendChild(node);
}
// ---------- 发音：单词出现自动读一次 + 🔊 按需读 + 提交后读音赶在下个词前播完 ----------
const tts = createTtsPlayer();
function speak(text) { return tts.speak(text); }
function stopSpeak() { tts.stop(); }
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
// 等 launch 动画放完（animationend），800ms 兜底防动画被中断/关闭时卡住流程
function waitForLaunch(el) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.removeEventListener("animationend", finish);
      resolve();
    };
    el.addEventListener("animationend", finish);
    setTimeout(finish, 800);
  });
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

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

// ---------- identity ----------
async function showIdentity() {
  const users = await api("/users");
  const wrap = $(`<section><h1>🧑‍🚀 选择你的宇航员</h1><div class="grid id-grid"></div></section>`);
  const grid = wrap.querySelector(".grid");
  users.forEach((u) => {
    const card = $(`<button class="card user"><div class="avatar">${escapeHtml(u.avatar)}</div><div>${escapeHtml(u.name)}</div></button>`);
    card.onclick = () => {
      currentUser = u;
      localStorage.setItem("dotvocab_user", JSON.stringify(u));
      showHome();
    };
    grid.appendChild(card);
  });
  render(wrap);
}

// ---------- home ----------
async function showHome() {
  const home = await api(`/home?user_id=${currentUser.id}`);
  const wrap = $(`<section>
    <header class="top"><button class="link" id="switch">切换用户</button>
      <div class="me">${escapeHtml(currentUser.avatar)} ${escapeHtml(currentUser.name)}</div></header>
    <div class="stats"><div class="stat">⭐ ${home.stars}</div><div class="stat">🔥 ${home.streak_days}</div><div class="stat">🛸 ${home.due_count}</div></div>
    <button class="big" id="review">🚀 今日任务 (${home.due_count})</button>
    <h2>🪐 选择星球关卡</h2>
    <div class="units"></div>
  </section>`);
  wrap.querySelector("#switch").onclick = () => { currentUser = null; localStorage.removeItem("dotvocab_user"); showIdentity(); };
  wrap.querySelector("#review").onclick = () => startSession({ mode: "due" });
  const ul = wrap.querySelector(".units");
  const grouped = {};
  home.units.forEach((u) => { (grouped[u.book] = grouped[u.book] || []).push(u); });
  Object.keys(grouped).sort().forEach((book) => {
    const sec = $(`<div><h3>${escapeHtml(book)}</h3><div class="grid"></div></div>`);
    grouped[book].forEach((u) => {
      const card = $(`<button class="card unit"><div>${escapeHtml(u.unit)}</div>
        <div class="bar" style="--pct:${u.pct}%"><i style="width:${u.pct}%"></i></div><small>${u.covered}/${u.total} · ${u.pct}%</small></button>`);
      card.onclick = () => startSession({ mode: "unit", unit_id: u.unit_id, title: `${book} · ${u.unit}` });
      sec.querySelector(".grid").appendChild(card);
    });
    ul.appendChild(sec);
  });
  render(wrap);
}

// ---------- session ----------
async function startSession({ mode, unit_id, title }) {
  tts.unlock(); // 还在手势调用栈内：借一次静音播放换取整局自动读音权限
  let words;
  try {
    if (mode === "due") words = await api(`/session/due?user_id=${currentUser.id}`);
    else words = await api(`/session/unit`, { method: "POST", body: JSON.stringify({ user_id: currentUser.id, unit_id }) });
  } catch (e) {
    render($(`<section><h2>${escapeHtml(title || "今日任务")}</h2>
      <p class="bad">任务加载失败了：${escapeHtml(e.message)}</p>
      <button class="big" id="back">返回基地</button></section>`));
    document.getElementById("back").onclick = showHome;
    return;
  }
  const queue = words.slice();
  tts.prefetch(queue.map((w) => w.term)); // 预热音频缓存：单词出现时读音秒起，不等冷合成（失败静默）
  const retry = [];
  const wrongCount = {}; // per-word wrong-attempt count, to cap retries
  const dropped = [];    // words that exhausted retries without a single success
  const stats = { done: 0, correct: 0 };
  let wrongTotal = 0;   // total wrong attempts (for progress)
  let streak = 0;       // 连击：连续答对数
  let aborted = false;  // kid quit mid-session: stop pending timers/advances
  if (queue.length === 0) { render($(`<section><h2>${title || "今日任务"}</h2><p>太空里没有待复习的单词啦 🎉</p><button class="big" id="back">返回基地</button></section>`)); document.getElementById("back").onclick = showHome; return; }

  async function quitSession() {
    const ok = await showConfirm({
      title: "🚀 要返回基地吗？",
      message: "进度已经保存，下次可以继续哦",
      okText: "返回基地",
      cancelText: "继续任务",
    });
    if (!ok) return;
    aborted = true;
    stopSpeak(); // 半路退出：立刻安静，不带声音回基地
    showHome();
  }

  function updateProgress() {
    const attempted = stats.done + wrongTotal;
    const remaining = queue.length + retry.length;
    const pct = attempted + remaining === 0 ? 0 : Math.round((attempted / (attempted + remaining)) * 100);
    const barEl = document.querySelector(".progress");
    if (barEl) {
      barEl.style.setProperty("--pct", pct + "%");
      barEl.querySelector("i").style.width = pct + "%";
    }
  }

  // ---------- 学习界面（整局只建一次，2026-08-23） ----------
  // iPad 的键盘只对手势内的 focus() 弹出，且 DOM 重建会丢焦点、收键盘。
  // 因此学习卡片整局持久，换词时原地更新；提交/发音按钮 pointerdown 不抢焦点，
  // 输入框焦点全程不动 —— 虚拟键盘常驻，孩子换词无需再点输入框。
  let study = null;
  let actionHandler = null; // 提交 ↔ 下一题：Enter 和按钮共用同一个动作

  function ensureStudy() {
    if (study) return study;
    const card = $(`<section class="study">
      <header class="top"><h2>${escapeHtml(title || "今日任务")}</h2><button class="link" id="quit">✖️ 退出</button></header>
      <div class="progress"><i></i></div>
      <div class="wordcard">
        <button class="tap-word" id="play" aria-label="听发音" style="margin-bottom:1rem;">
          <span class="audio-hint" style="font-size:2rem;">🔊</span>
          <small class="tap-hint">听发音</small>
        </button>
        <div class="meaning" id="meaning"></div>
      </div>
      <div class="spell-row">
        <div class="spell-input">
          <div class="spell-mirror" id="mirror"></div>
          <input type="password" id="ans"
                 autocorrect="off" autocapitalize="off" autocomplete="off"
                 spellcheck="false" inputmode="text"
                 aria-label="拼写英文单词" />
        </div>
        <button class="big" id="action">提交</button>
      </div>
      <div id="fb" class="fb"></div>
    </section>`);
    card.querySelector("#quit").onclick = quitSession;
    // 点击不抢输入框焦点（preventDefault 只拦截聚焦，click 照常触发），键盘不落
    const keepFocus = (e) => e.preventDefault();
    card.querySelector("#play").addEventListener("pointerdown", keepFocus);
    card.querySelector("#action").addEventListener("pointerdown", keepFocus);
    card.querySelector("#action").onclick = () => actionHandler && actionHandler();
    const inp = card.querySelector("#ans");
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") actionHandler && actionHandler(); });
    const { render: spellRender } = makeSpellInput(inp, card.querySelector("#mirror"), "拼写英文单词");
    render(card);
    updateProgress();
    study = {
      inp, spellRender,
      play: card.querySelector("#play"),
      meaning: card.querySelector("#meaning"),
      wordcard: card.querySelector(".wordcard"),
      fb: card.querySelector("#fb"),
      action: card.querySelector("#action"),
    };
    return study;
  }

  await nextCard();

  async function nextCard() {
    if (aborted) return;
    if (queue.length === 0 && retry.length) { queue.push(...retry.splice(0)); }
    if (queue.length === 0) return finish();
    const w = queue.shift();
    updateProgress();
    await spellingCard(w);
  }

  function spellingCard(w) {
    return new Promise((resolve) => {
      const s = ensureStudy();
      s.play.onclick = () => { speak(w.term); s.inp.focus(); };
      s.meaning.innerHTML = `${w.pos ? `<span class="pos">${escapeHtml(w.pos)}.</span>` : ""}${escapeHtml(w.meaning_cn)}`;
      s.fb.innerHTML = "";
      s.action.textContent = "提交";
      s.wordcard.classList.remove("launch", "shake"); // 上一个词的动效复位
      s.inp.value = "";
      s.spellRender();
      s.inp.focus();
      speak(w.term); // 单词出现自动读一次（被拦就静默，🔊 按钮仍可按需读）
      let submitted = false; // guard against double Enter / double-tap

      async function submit() {
        if (submitted) return; // ignore repeated submits (double Enter)
        submitted = true;
        const ans = s.inp.value.trim().toLowerCase();
        const correct = ans === w.term.toLowerCase();
        // 乐观 UI：对错本地即判、反馈立刻渲染；/review 与 /cover 后台并行上报，
        // 一滴不阻塞判定。上报失败只弹非阻塞提示——进度没存上，下次这个词
        // 还会出现，对孩子无损，绝不让网络卡住学习节奏。
        recordAnswer({
          post: (path, body) => api(path, { method: "POST", body: JSON.stringify(body) }),
          userId: currentUser.id,
          wordId: w.id,
          correct,
          unitId: unit_id || null,
          onError: () => showToast("😵 网络开小差了，刚才的进度可能没存上", "bad"),
        });
        if (aborted) return;
        actionHandler = null; // 反馈期间按钮/Enter 不再响应
        if (correct) {
          stats.done++; stats.correct++;
          streak++;
          const combo = streak >= 3 ? `<span class="combo">🔥 连击 x${streak}</span>` : "";
          s.fb.innerHTML = `<div><span class="ok">✅ 对！⭐</span>${combo}</div>`;
          sfx.correct();
          // 时序：判定先出 → 读音在静态卡片上播完（不与动画重叠，避免 iOS 机械音
          // 阻塞主线程冻住动画）→ launch 动画送走卡片 → 动画放完才出现下一个词
          const spoken = speak(w.term);
          await Promise.all([delay(500), spoken]);
          if (aborted) return;
          s.wordcard.classList.add("launch");
          await waitForLaunch(s.wordcard);
          if (!aborted) resolve(nextCard());
        } else {
          streak = 0;
          wrongCount[w.id] = (wrongCount[w.id] || 0) + 1;
          wrongTotal++;
          const cmp = diffHtml(w.term.toLowerCase(), ans);
          s.fb.innerHTML = `<div><span class="bad">🚀 差一点点！正确：<span class="cmp">${cmp}</span></span></div>`;
          s.wordcard.classList.add("shake");
          sfx.wrong();
          speak(w.term); // 与阅读正确拼写并行；点「下一题」立即打断残留读音
          if (wrongCount[w.id] < 3) retry.push(w); // cap so kids can't soft-lock
          else dropped.push(w);
          s.action.textContent = "下一题";
          actionHandler = () => { if (!aborted) { stopSpeak(); resolve(nextCard()); } }; // 孩子操作优先：打断残留读音立即切词
        }
      }
      actionHandler = submit;
    });
  }

  function finish() {
    study = null; // 本局结束：学习界面随庆祝页整体替换，键盘可以收起
    const practice = dropped.length
      ? `<div class="dropped"><p>💪 这几个词还有点难，点一点再听一遍：</p>
         <p class="dropped-words">${dropped.map((w) => `<button class="link wterm" data-term="${escapeHtml(w.term)}">🔊 ${escapeHtml(w.term)}</button>`).join("")}</p>
         <p><small>回基地后点「今日任务」可以马上再挑战它们！</small></p></div>`
      : "";
    const card = $(`<section class="study">
      <h2>🛬 着陆成功！</h2>
      <p>完成 ${stats.done} 个任务，拼对 ${stats.correct} 个，获得 ⭐ x ${stats.correct}！</p>
      ${practice}
      <button class="big" id="back">返回基地</button>
    </section>`);
    celebrate();
    sfx.finish();
    card.querySelectorAll(".wterm").forEach((b) => { b.onclick = () => speak(b.dataset.term); });
    card.querySelector("#back").onclick = showHome;
    render(card);
  }

  function celebrate() {
    const c = document.createElement("div");
    c.className = "confetti";
    const emo = ["⭐", "🎉", "🚀", "🌟", "✨"];
    for (let i = 0; i < 18; i++) {
      const s = document.createElement("span");
      s.textContent = emo[i % emo.length];
      s.style.setProperty("--x", Math.random() * 100 + "%");
      s.style.setProperty("--d", 1.6 + Math.random() * 1.8 + "s");
      s.style.setProperty("--r", Math.random() * 720 - 360 + "deg");
      s.style.setProperty("--s", 18 + Math.random() * 16 + "px");
      c.appendChild(s);
    }
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 4000);
  }
}

// ---------- boot ----------
(async function boot() {
  try {
    if (currentUser) await showHome();
    else await showIdentity();
  } catch (e) {
    render($(`<section><p class="bad">网络出错了：${escapeHtml(e.message)}</p><button class="big" onclick="location.reload()">重试</button></section>`));
  }
})();
