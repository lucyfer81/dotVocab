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
function speak(text) {
  if ("speechSynthesis" in window) {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    speechSynthesis.speak(u);
  }
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- identity ----------
async function showIdentity() {
  const users = await api("/users");
  const wrap = $(`<section><h1>谁在背单词？</h1><div class="grid id-grid"></div></section>`);
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
    <div class="stats"><div class="stat">⭐ ${home.stars}</div><div class="stat">🔥 ${home.streak_days}</div><div class="stat">📥 待复习 ${home.due_count}</div></div>
    <button class="big" id="review">今日复习 (${home.due_count})</button>
    <h2>按课本学</h2>
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
        <div class="bar"><i style="width:${u.pct}%"></i></div><small>${u.covered}/${u.total} · ${u.pct}%</small></button>`);
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
  if (queue.length === 0) { render($(`<section><h2>${title || "今日复习"}</h2><p>没有要学的词啦 🎉</p><button class="big" id="back">返回</button></section>`)); document.getElementById("back").onclick = showHome; return; }
  await nextCard();

  async function nextCard() {
    if (queue.length === 0 && retry.length) { queue.push(...retry.splice(0)); }
    if (queue.length === 0) return finish();
    const w = queue.shift();
    await showWordIntro(w);
  }

  function showWordIntro(w) {
    return new Promise((resolve) => {
      const isNew = (w.reps || 0) === 0 && (w.due_at || 0) === 0;
      if (!isNew) { resolve(spellingCard(w)); return; }
      const card = $(`<section class="study">
        <h2>${escapeHtml(title || "今日复习")}</h2>
        <div class="wordcard">
          <button class="tap-word" id="play" aria-label="朗读 ${escapeHtml(w.term)}">
            <span class="term">${escapeHtml(w.term)}</span><span class="audio-hint">🔊</span>
            <small class="tap-hint">点单词朗读</small>
          </button>
          <div class="meaning">${w.pos ? `<span class="pos">${escapeHtml(w.pos)}.</span>` : ""}${escapeHtml(w.meaning_cn)}</div>
          ${w.example_en ? `<div class="ex">${escapeHtml(w.example_en)}<br><span class="muted">${escapeHtml(w.example_cn || "")}</span></div>` : ""}
        </div>
        <button class="big" id="start">开始拼写</button>
      </section>`);
      card.querySelector("#play").onclick = () => speak(w.term);
      card.querySelector("#start").onclick = () => { render(document.createElement("div")); resolve(spellingCard(w)); };
      render(card);
    });
  }

  function spellingCard(w) {
    return new Promise((resolve) => {
      const card = $(`<section class="study">
        <h2>${escapeHtml(title || "今日复习")}</h2>
        <div class="progress"><i id="bar"></i></div>
        <div class="wordcard">
          <div class="meaning">${w.pos ? `<span class="pos">${escapeHtml(w.pos)}.</span>` : ""}${escapeHtml(w.meaning_cn)}</div>
        </div>
        <input id="ans" autocapitalize="none" autocomplete="off" spellcheck="false" placeholder="拼写英文单词" />
        <div id="fb" class="fb"></div>
        <button class="big" id="submit">提交</button>
      </section>`);
      render(card);
      const inp = card.querySelector("#ans"); inp.focus();
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
          fb.innerHTML = `<div class="ok">✅ 对！⭐</div>`;
          speak(w.term);
          setTimeout(() => { resolve(nextCard()); }, 700);
        } else {
          wrongCount[w.id] = (wrongCount[w.id] || 0) + 1;
          const cmp = diff(w.term.toLowerCase(), ans);
          fb.innerHTML = `<div class="bad">✗ 正确：<span class="cmp">${cmp}</span></div>`;
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
      <h2>完成！🎉</h2>
      <p>本组 ${stats.done} 题，拼对 ${stats.correct} 个。</p>
      <button class="big" id="back">返回首页</button>
    </section>`);
    card.querySelector("#back").onclick = showHome;
    render(card);
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
