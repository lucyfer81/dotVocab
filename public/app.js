import { shouldRejectInputType, sanitizeValue, renderMirrorHtml } from "./spell-helpers.js";
import { sfx } from "./sfx.js";

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
let ttsAudio;
function speak(text) {
  const url = `/api/tts?term=${encodeURIComponent(text)}&lang=en-US`;
  if (!ttsAudio) ttsAudio = new Audio();
  ttsAudio.src = url;
  ttsAudio.play().catch(() => {
    // 合成失败 / 网络失败：回退浏览器机械音，保证按钮永不哑
    if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US";
      speechSynthesis.speak(u);
    }
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
  let words;
  if (mode === "due") words = await api(`/session/due?user_id=${currentUser.id}`);
  else words = await api(`/session/unit`, { method: "POST", body: JSON.stringify({ user_id: currentUser.id, unit_id }) });
  const queue = words.slice();
  const retry = [];
  const wrongCount = {}; // per-word wrong-attempt count, to cap retries
  const stats = { done: 0, correct: 0 };
  let wrongTotal = 0;   // total wrong attempts (for progress)
  let streak = 0;       // 连击：连续答对数
  if (queue.length === 0) { render($(`<section><h2>${title || "今日任务"}</h2><p>太空里没有待复习的单词啦 🎉</p><button class="big" id="back">返回基地</button></section>`)); document.getElementById("back").onclick = showHome; return; }

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

  await nextCard();

  async function nextCard() {
    if (queue.length === 0 && retry.length) { queue.push(...retry.splice(0)); }
    if (queue.length === 0) return finish();
    const w = queue.shift();
    updateProgress();
    await spellingCard(w);
  }

  function spellingCard(w) {
    return new Promise((resolve) => {
      const card = $(`<section class="study">
        <h2>${escapeHtml(title || "今日任务")}</h2>
        <div class="progress"><i></i></div>
        <div class="wordcard">
          <button class="tap-word" id="play" aria-label="听发音" style="margin-bottom:1rem;">
            <span class="audio-hint" style="font-size:2rem;">🔊</span>
            <small class="tap-hint">听发音</small>
          </button>
          <div class="meaning">${w.pos ? `<span class="pos">${escapeHtml(w.pos)}.</span>` : ""}${escapeHtml(w.meaning_cn)}</div>
        </div>
        <div class="spell-input">
          <div class="spell-mirror" id="mirror"></div>
          <input type="password" id="ans"
                 autocorrect="off" autocapitalize="off" autocomplete="off"
                 spellcheck="false" inputmode="text"
                 aria-label="拼写英文单词" />
        </div>
        <div id="fb" class="fb"></div>
        <button class="big" id="submit">提交</button>
      </section>`);
      card.querySelector("#play").onclick = () => { speak(w.term); inp.focus(); };
      render(card);
      const inp = card.querySelector("#ans");
      const mirror = card.querySelector("#mirror");
      makeSpellInput(inp, mirror, "拼写英文单词");
      inp.focus();
      let submitted = false; // guard against double Enter / double-tap
      card.querySelector("#submit").onclick = submit;
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });

      async function submit() {
        if (submitted) return; // ignore repeated submits (double Enter)
        submitted = true;
        card.querySelector("#submit").onclick = null;
        const ans = inp.value.trim().toLowerCase();
        const correct = ans === w.term.toLowerCase();
        await api("/review", { method: "POST", body: JSON.stringify({ user_id: currentUser.id, word_id: w.id, correct }) });
        if (unit_id) await api("/cover", { method: "POST", body: JSON.stringify({ user_id: currentUser.id, unit_id, word_id: w.id }) });
        const fb = card.querySelector("#fb");
        if (correct) {
          stats.done++; stats.correct++;
          streak++;
          const combo = streak >= 3 ? `<span class="combo">🔥 连击 x${streak}</span>` : "";
          fb.innerHTML = `<div><span class="ok">✅ 对！⭐</span>${combo}</div>`;
          card.querySelector(".wordcard").classList.add("launch");
          sfx.correct();
          speak(w.term);
          setTimeout(() => { resolve(nextCard()); }, 750);
        } else {
          streak = 0;
          wrongCount[w.id] = (wrongCount[w.id] || 0) + 1;
          wrongTotal++;
          const cmp = diff(w.term.toLowerCase(), ans);
          fb.innerHTML = `<div><span class="bad">🚀 差一点点！正确：<span class="cmp">${cmp}</span></span></div>`;
          card.querySelector(".wordcard").classList.add("shake");
          sfx.wrong();
          speak(w.term);
          if (wrongCount[w.id] < 3) retry.push(w); // cap so kids can't soft-lock
          const next = $(`<button class="big" id="next">下一题</button>`);
          card.querySelector("#submit").replaceWith(next);
          next.onclick = () => resolve(nextCard());
        }
      }
    });
  }

  function diff(answer, given) {
    let out = "";
    for (let i = 0; i < answer.length; i++) {
      const a = answer[i], g = given[i] || "";
      out += g === a ? `<b class="ok">${escapeHtml(a)}</b>` : `<b class="bad">${escapeHtml(a)}</b>`;
    }
    return out;
  }

  function finish() {
    const card = $(`<section class="study">
      <h2>🛬 着陆成功！</h2>
      <p>完成 ${stats.done} 个任务，拼对 ${stats.correct} 个，获得 ⭐ x ${stats.correct}！</p>
      <button class="big" id="back">返回基地</button>
    </section>`);
    celebrate();
    sfx.finish();
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
