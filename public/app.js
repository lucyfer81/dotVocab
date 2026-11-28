import { shouldRejectInputType, sanitizeValue, renderMirrorHtml, diffHtml } from "./spell-helpers.js";
import { sfx } from "./sfx.js";
import { showConfirm, showToast } from "./ui.js";
import { createTtsPlayer } from "./tts-player.js";
import { matchesDailySpelling, normalizeDailyAnswer } from "./daily-judge.js";
import { createDailySync, recordPracticeAnswer, scheduleDailyItems } from "./review-client.js";
import { slugFromPath, nameForSlug, resolveUser, SLUG_BY_NAME } from "./user-routing.js";

const API = "/api";
let currentUser;
let dailySync;
let openingDaily = false;

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || "请求失败");
    err.status = res.status; // 上报层按 409（清单已过日）等状态码分流
    throw err;
  }
  return res.json();
}
const postJson = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });

async function postDailySync(path, body) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeout = controller && setTimeout(() => controller.abort(), 15000);
  try {
    return await api(path, { method: "POST", body: JSON.stringify(body), signal: controller?.signal });
  } finally {
    clearTimeout(timeout);
  }
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
// 加练的本地判定：按服务端下发的 accepted（别名表）trim+小写全等比较；
// accepted 缺失时退回 term 本身。与每日作答的服务端判定同一归一规则。
function judgeAccepted(accepted, term, ans) {
  const a = String(ans ?? "").trim().toLowerCase();
  const list = Array.isArray(accepted) && accepted.length ? accepted : [term];
  return list.some((x) => String(x).trim().toLowerCase() === a);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
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
      const slug = SLUG_BY_NAME[u.name];
      if (slug) location.href = "/" + slug; // 无代号的用户不跳转
    };
    grid.appendChild(card);
  });
  render(wrap);
}

function renderLoadError(title, e) {
  render($(`<section><h2>${escapeHtml(title)}</h2>
    <p class="bad">任务加载失败了：${escapeHtml(e.message)}</p>
    <button class="big" id="back">返回基地</button></section>`));
  document.getElementById("back").onclick = showHome;
}

// ---------- home ----------
async function showHome() {
  const home = await api(`/home?user_id=${currentUser.id}`);
  const daily = home.daily; // 今日已生成清单的只读快照；没有则点击时才生成
  const wrap = $(`<section>
    <header class="top"><button class="link" id="switch">切换用户</button>
      <div class="me">${escapeHtml(currentUser.avatar)} ${escapeHtml(currentUser.name)}</div></header>
    <div class="stats"><div class="stat">⭐ ${home.stars}</div><div class="stat">🔥 ${home.streak_days}</div>
      <div class="stat">🚀 ${daily ? `${daily.done}/${daily.total}` : "—"}</div></div>
    <button class="big" id="review"></button>
    <button class="big" id="mistakes"></button>
  </section>`);
  wrap.querySelector("#switch").onclick = () => { location.href = "/"; };

  // 今日任务卡：有清单显示权威进度；空清单日用统一文案（同日原因标签可能随池漂移，
  // 任务 5 Minor-3 —— 两种空原因共用一句孩子能理解的话）；未生成则点击时生成。
  const rb = wrap.querySelector("#review");
  if (daily && daily.total === 0) {
    rb.textContent = "😴 今天没有要学的词（问问爸爸妈妈是否开放新单元）";
    rb.disabled = true;
  } else {
    rb.textContent = daily ? `🚀 今日任务 (${daily.done}/${daily.total})` : "🚀 开始今日任务";
    rb.onclick = () => startDailySession();
  }

  const mb = wrap.querySelector("#mistakes");
  if (home.mistakeCount > 0) {
    mb.textContent = `📒 错词本 (${home.mistakeCount})`;
    mb.onclick = startMistakeSession;
  } else {
    mb.textContent = "📒 错词本 · 太棒了，没有错词！";
    mb.disabled = true;
  }

  render(wrap);
}

// ---------- 学习卡片（每日/加练共用骨架，整局持久防 iOS 键盘掉焦） ----------
// iPad 的键盘只对手势内的 focus() 弹出，且 DOM 重建会丢焦点、收键盘。
// 因此学习卡片整局持久，换词时原地更新；提交/发音按钮 pointerdown 不抢焦点，
// 输入框焦点全程不动 —— 虚拟键盘常驻，孩子换词无需再点输入框。
function buildStudyCard(title, withReveal) {
  return $(`<section class="study">
    <header class="top"><h2>${escapeHtml(title)}</h2><button class="link" id="quit">✖️ 退出</button></header>
    <div class="progress"><i></i></div>
    <div class="wordcard">
      <button class="tap-word" id="play" aria-label="听发音" style="margin-bottom:1rem;">
        <span class="audio-hint" style="font-size:2rem;">🔊</span>
        <small class="tap-hint">听发音</small>
      </button>
      <div class="meaning" id="meaning"></div>
      ${withReveal ? `<button class="link" id="reveal" style="margin-top:.6rem;">🙈 先看答案</button>` : ""}
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
}

// ---------- 每日任务：本地判题，后台按顺序同步 ----------
async function startDailySession() {
  if (openingDaily) return;
  openingDaily = true;
  tts.unlock(); // 还在手势调用栈内：借一次静音播放换取整局自动读音权限
  const confirmedDuringOpen = [];
  const unsubscribe = dailySync.subscribe((event, result) => {
    if (result) confirmedDuringOpen.push({ day: event.day, item: result.item });
  });
  let opened;
  try {
    opened = await postJson("/daily/open", { userId: currentUser.id });
  } catch (e) {
    renderLoadError("今日任务", e);
    return;
  } finally {
    unsubscribe();
    openingDaily = false;
  }
  if (opened.emptyReason) {
    // 统一文案：清单固定后，同一天里 emptyReason 可能随共享池变化而漂移
    //（任务 5 Minor-3），两种空原因共用一句孩子能理解的话。
    render($(`<section><h2>今日任务</h2>
      <p>今天没有要学的词（问问爸爸妈妈是否开放新单元）🌙</p>
      <button class="big" id="back">返回基地</button></section>`));
    document.getElementById("back").onclick = showHome;
    return;
  }
  runDailySession(opened, confirmedDuringOpen);
}

function runDailySession(opened, confirmedDuringOpen) {
  const title = "今日任务";
  const items = opened.items;
  const total = items.length;
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const confirmed = new Map(items.map((item) => [item.id, item.status]));
  for (const { day, item } of confirmedDuringOpen) {
    if (day === opened.day && confirmed.has(item.id) && confirmed.get(item.id) !== "done") {
      confirmed.set(item.id, item.status);
    }
  }
  const statusById = new Map();
  const sessionEvents = new Set();
  const deferred = new Set();
  let completed = 0;
  let stars = 0;
  let firstRight = 0; // 首次独立拼对的条目数（订正不计）
  let streak = 0;     // 连击：连续答对数
  let aborted = false;
  let study = null;
  let actionHandler = null;
  let currentReveal = null; // 当前卡的「先看答案」动作（ensureStudy 只建一次 DOM）
  let activeItemId;
  let feedbackEventId;
  let finishCard;
  let pending = [];

  function isCorrect(item, action, answer) {
    return matchesDailySpelling(normalizeDailyAnswer(action, answer), item.accepted ?? []);
  }

  function refreshStatuses() {
    for (const [id, status] of confirmed) statusById.set(id, status);
    pending = dailySync.entries().filter((event) => event.day === opened.day && itemsById.has(event.itemId));
    for (const event of pending) {
      const status = statusById.get(event.itemId);
      if (status === "done") continue;
      const correct = isCorrect(itemsById.get(event.itemId), event.action, event.answer);
      statusById.set(event.itemId, correct ? "done" : "correction");
    }
    completed = [...statusById.values()].filter((status) => status === "done").length;
  }

  function remainingItems() {
    const scheduled = scheduleDailyItems(items.map((item) => ({ ...item, status: statusById.get(item.id) })));
    const deferredItems = new Map(scheduled.filter((item) => item.status === "correction" && deferred.has(item.id))
      .map((item) => [item.id, item]));
    return scheduled.filter((item) => !deferredItems.has(item.id))
      .concat([...deferred].map((id) => deferredItems.get(id)).filter(Boolean));
  }

  refreshStatuses();
  if (completed === total && pending.length === 0) {
    render($(`<section><h2>${escapeHtml(title)}</h2><p>今天的任务已经全部完成啦 🎉 明天再来吧！</p>
      <button class="big" id="back">返回基地</button></section>`));
    document.getElementById("back").onclick = showHome;
    return;
  }

  const unsubscribe = dailySync.subscribe((event, result, rejection) => {
    if (event?.day === opened.day && itemsById.has(event.itemId)) {
      if (rejection === "stale_day") return showStaleDay();
      if (result) {
        confirmed.set(result.item.id, result.item.status);
        if (sessionEvents.has(event.eventId) && result.applied) {
          stars += result.starsAwarded || 0;
          if (result.stage === "first" && result.correct) firstRight++;
          if (event.eventId === feedbackEventId && result.starsAwarded > 0) {
            study?.fb.querySelector(".ok")?.append(" ⭐");
          }
        }
      }
      if (rejection) showToast("有一条答案未能保存，请重新作答", "bad");
    }
    refreshStatuses();
    updateProgress();
    updateSyncStatus();
  });

  function returnHome() {
    aborted = true;
    unsubscribe();
    stopSpeak();
    showHome();
  }

  async function quitSession() {
    const ok = await showConfirm({
      title: "🚀 要返回基地吗？",
      message: pending.length ? "还有答案待同步，下次回来可以继续" : "进度已经保存，下次可以继续哦",
      okText: "返回基地",
      cancelText: "继续任务",
    });
    if (!ok) return;
    returnHome();
  }

  function updateProgress() {
    const pct = total === 0 ? 0 : Math.round((completed / total) * 100);
    const barEl = document.querySelector(".progress");
    if (barEl) {
      barEl.style.setProperty("--pct", pct + "%");
      barEl.querySelector("i").style.width = pct + "%";
    }
  }

  function ensureStudy() {
    if (study) return study;
    const card = buildStudyCard(title, true);
    card.insertAdjacentHTML("beforeend", '<p class="muted" id="daily-sync" role="status" hidden></p>');
    card.querySelector("#quit").onclick = quitSession;
    // 点击不抢输入框焦点（preventDefault 只拦截聚焦，click 照常触发），键盘不落
    const keepFocus = (e) => e.preventDefault();
    card.querySelector("#play").addEventListener("pointerdown", keepFocus);
    card.querySelector("#action").addEventListener("pointerdown", keepFocus);
    card.querySelector("#reveal").addEventListener("pointerdown", keepFocus);
    card.querySelector("#action").onclick = () => actionHandler && actionHandler();
    card.querySelector("#reveal").onclick = () => currentReveal && currentReveal();
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
      reveal: card.querySelector("#reveal"),
      sync: card.querySelector("#daily-sync"),
    };
    updateSyncStatus();
    return study;
  }

  function showStaleDay() {
    aborted = true;
    unsubscribe();
    stopSpeak();
    render($(`<section><h2>🌙 清单已过日</h2>
      <p>这份清单已过期，尚未同步的答案无法计入进度。请打开今天的清单。</p>
      <button class="big" id="reopen">打开今日清单</button>
      <button class="link" id="back">返回基地</button></section>`));
    document.getElementById("reopen").onclick = () => startDailySession();
    document.getElementById("back").onclick = showHome;
  }

  function updateSyncStatus() {
    const status = study?.sync ?? finishCard?.querySelector("#daily-sync");
    if (status) {
      status.hidden = pending.length === 0;
      status.textContent = pending.some((event) => !event.durable)
        ? `${pending.length} 个答案待同步，请保持页面打开`
        : `${pending.length} 个答案待同步`;
    }
    if (finishCard) {
      finishCard.querySelector("h2").textContent = completed === total ? "🛬 着陆成功！" : "还有单词需要练习";
      finishCard.querySelector("#summary").textContent = `完成 ${completed} 个任务，独立拼对 ${firstRight} 个，获得 ⭐ x ${stars}！`;
      finishCard.querySelector("#continue").hidden = completed === total;
    }
  }

  nextCard();
  void dailySync.flush();

  function nextCard(deferItemId) {
    if (aborted) return;
    if (deferItemId != null) {
      deferred.delete(deferItemId);
      deferred.add(deferItemId);
    }
    const queue = remainingItems();
    const [w] = queue;
    activeItemId = w?.id;
    feedbackEventId = undefined;
    if (!w) return finish();
    void tts.prefetch(queue.slice(0, 3).map((item) => item.term));
    updateProgress();
    spellingCard(w);
  }

  function spellingCard(w) {
    const s = ensureStudy();
    let submitted = false; // guard against double Enter / double-tap
    s.play.onclick = () => { speak(w.term); s.inp.focus(); };
    s.meaning.innerHTML = escapeHtml(w.meaning);
    s.fb.innerHTML = "";
    s.reveal.disabled = false;
    s.action.textContent = "提交";
    s.wordcard.classList.remove("launch", "shake"); // 上一个词的动效复位
    s.inp.value = "";
    s.spellRender();
    s.inp.focus();
    speak(w.term); // 单词出现自动读一次（被拦就静默，🔊 按钮仍可按需读）

    function applyResult(correct, raw) {
      if (correct) {
        streak++;
        const combo = streak >= 3 ? `<span class="combo">🔥 连击 x${streak}</span>` : "";
        s.fb.innerHTML = `<div><span class="ok">✅ 对！</span>${combo}</div>`;
        sfx.correct();
        // 时序：判定先出 → 读音在静态卡片上播完（不与动画重叠，避免 iOS 机械音
        // 阻塞主线程冻住动画）→ launch 动画送走卡片 → 动画放完才出现下一个词
        const spoken = speak(w.term);
        Promise.all([delay(500), spoken]).then(async () => {
          if (aborted) return;
          s.wordcard.classList.add("launch");
          await waitForLaunch(s.wordcard);
          if (!aborted) nextCard();
        });
      } else {
        streak = 0;
        const cmp = diffHtml(w.term.toLowerCase(), raw.toLowerCase());
        s.fb.innerHTML = `<div><span class="bad">🚀 差一点点！正确：<span class="cmp">${cmp}</span></span></div>`;
        s.wordcard.classList.add("shake");
        sfx.wrong();
        speak(w.term); // 与阅读正确拼写并行；点「下一题」立即打断残留读音
        s.action.textContent = "下一题";
        actionHandler = () => { if (!aborted) { stopSpeak(); nextCard(w.id); } };
      }
    }

    function queueAnswer(action, answer) {
      const eventId = dailySync.enqueue({ day: opened.day, itemId: w.id, action, answer });
      sessionEvents.add(eventId);
      feedbackEventId = eventId;
    }

    function submitSpell() {
      if (submitted) return;
      if (activeItemId !== w.id || statusById.get(w.id) === "done") return nextCard();
      submitted = true;
      const raw = s.inp.value.trim();
      actionHandler = null; // 反馈期间按钮/Enter 不再响应
      queueAnswer("spell", raw);
      applyResult(isCorrect(w, "spell", raw), raw);
    }

    // 主动揭示：action='reveal'（首次看答案记 Again；订正中的揭示记一次失败订正）。
    // 揭示后留在本卡，孩子随即把已知答案拼对即完成订正。
    currentReveal = function revealWord() {
      if (submitted) return;
      if (activeItemId !== w.id || statusById.get(w.id) === "done") return nextCard();
      s.reveal.disabled = true;
      queueAnswer("reveal", null);
      s.fb.innerHTML = `<div><span class="muted">👀 答案是：<span class="cmp">${escapeHtml(w.term)}</span></span>
        <p><small>先记一次小失误，把它拼对就算订正成功！</small></p></div>`;
      sfx.wrong();
      speak(w.term);
      s.inp.value = "";
      s.spellRender();
      s.inp.focus();
    };

    actionHandler = submitSpell;
  }

  function finish() {
    study = null; // 本局结束：学习界面随庆祝页整体替换，键盘可以收起
    finishCard = $(`<section class="study">
      <h2>🛬 着陆成功！</h2>
      <p id="summary"></p>
      <p class="muted" id="daily-sync" role="status" hidden></p>
      <button class="big" id="continue" hidden>继续任务</button>
      <button class="big" id="back">返回基地</button>
    </section>`);
    celebrate();
    sfx.finish();
    finishCard.querySelector("#back").onclick = returnHome;
    finishCard.querySelector("#continue").onclick = () => { finishCard = null; nextCard(); };
    updateSyncStatus();
    render(finishCard);
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

// ---------- 自主加练：错词本 ----------
// 词条来自 /mistakes，判定在客户端本地按 accepted
// 别名表进行；练习日志经 recordPracticeAnswer 走 /review sense 路径——
// 不调 /daily/answer、不写 user_cards（不改 FSRS）、不完成每日条目。
async function startMistakeSession() {
  tts.unlock();
  const title = "错词本";
  let words;
  try {
    words = await api(`/mistakes?user_id=${currentUser.id}`);
  } catch (e) {
    renderLoadError(title, e);
    return;
  }
  if (words.length === 0) {
    render($(`<section><h2>${title}</h2><p>这里暂时没有可以练的词 🎉</p>
      <button class="big" id="back">返回基地</button></section>`));
    document.getElementById("back").onclick = showHome;
    return;
  }
  const queue = shuffle(words.slice());
  tts.prefetch(queue.map((w) => w.term)); // 预热音频缓存（失败静默）
  const retry = [];
  const wrongCount = {}; // per-word wrong-attempt count, to cap retries
  const dropped = [];    // words that exhausted retries without a single success
  const stats = { done: 0, correct: 0 };
  let wrongTotal = 0;
  let streak = 0;
  let aborted = false;
  let study = null;
  let actionHandler = null;

  async function quitSession() {
    const ok = await showConfirm({
      title: "🚀 要返回基地吗？",
      message: "练习随时可以再来，先休息一下也没关系",
      okText: "返回基地",
      cancelText: "继续练习",
    });
    if (!ok) return;
    aborted = true;
    stopSpeak();
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

  function ensureStudy() {
    if (study) return study;
    const card = buildStudyCard(title, false);
    card.querySelector("#quit").onclick = quitSession;
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
    const w = queue.shift();
    if (!w) return finish();
    updateProgress();
    await spellingCard(w);
  }

  function spellingCard(w) {
    return new Promise((resolve) => {
      const s = ensureStudy();
      s.play.onclick = () => { speak(w.term); s.inp.focus(); };
      s.meaning.innerHTML = escapeHtml(w.meaning);
      s.fb.innerHTML = "";
      s.action.textContent = "提交";
      s.wordcard.classList.remove("launch", "shake");
      s.inp.value = "";
      s.spellRender();
      s.inp.focus();
      speak(w.term);
      let submitted = false;

      async function submit() {
        if (submitted) return; // ignore repeated submits (double Enter)
        submitted = true;
        const raw = s.inp.value.trim();
        const correct = judgeAccepted(w.accepted, w.term, raw);
        // 乐观 UI：本地判定先出反馈；练习日志后台并行上报（同 eventId 自动重试一次），
        // 失败只做非阻塞提示——绝不让网络问题打断练习节奏。
        recordPracticeAnswer({
          post: postJson,
          userId: currentUser.id,
          senseId: w.senseId,
          correct,
          source: "mistake",
          answer: correct ? undefined : raw,
          onError: () => showToast("😵 网络开小差了，刚才的进度可能没存上", "bad"),
        });
        if (aborted) return;
        actionHandler = null; // 反馈期间按钮/Enter 不再响应
        if (correct) {
          stats.done++; stats.correct++;
          streak++;
          const combo = streak >= 3 ? `<span class="combo">🔥 连击 x${streak}</span>` : "";
          s.fb.innerHTML = `<div><span class="ok">✅ 对！</span>${combo}</div>`;
          sfx.correct();
          const spoken = speak(w.term);
          await Promise.all([delay(500), spoken]);
          if (aborted) return;
          s.wordcard.classList.add("launch");
          await waitForLaunch(s.wordcard);
          if (!aborted) resolve(nextCard());
        } else {
          streak = 0;
          wrongTotal++;
          wrongCount[w.senseId] = (wrongCount[w.senseId] || 0) + 1;
          const cmp = diffHtml(w.term.toLowerCase(), raw.toLowerCase());
          s.fb.innerHTML = `<div><span class="bad">🚀 差一点点！正确：<span class="cmp">${cmp}</span></span></div>`;
          s.wordcard.classList.add("shake");
          sfx.wrong();
          speak(w.term);
          if (wrongCount[w.senseId] < 3) retry.push(w); // cap so kids can't soft-lock
          else dropped.push(w);
          s.action.textContent = "下一题";
          actionHandler = () => { if (!aborted) { stopSpeak(); resolve(nextCard()); } };
        }
      }
      actionHandler = submit;
    });
  }

  function finish() {
    study = null;
    const practice = dropped.length
      ? `<div class="dropped"><p>💪 这几个词还有点难，点一点再听一遍：</p>
         <p class="dropped-words">${dropped.map((w) => `<button class="link wterm" data-term="${escapeHtml(w.term)}">🔊 ${escapeHtml(w.term)}</button>`).join("")}</p>
         <p><small>回基地后可以打开错词本再练！</small></p></div>`
      : "";
    const card = $(`<section class="study">
      <h2>🛬 练习完成！</h2>
      <p>练了 ${stats.done + dropped.length} 个词，拼对 ${stats.correct} 个，很棒！</p>
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
  try { localStorage.removeItem("dotvocab_user"); } catch {} // 清旧版记忆残留，尽力而为：清理失败不挡路（旧版 Safari 隐私模式等会抛异常）
  try {
    // 未知代号（打错字、多级路径）宽容回选择页；已知代号但数据库对不上才报错
    const slug = slugFromPath(location.pathname);
    if (!slug || !nameForSlug(slug)) return await showIdentity();
    const u = resolveUser(slug, await api("/users"));
    if (!u) {
      render($(`<section><h2>🧭 没找到这位宇航员</h2>
        <p class="bad">链接里的代号（${escapeHtml(slug)}）对不上任何用户</p>
        <button class="big" id="back">回基地选人</button></section>`));
      document.getElementById("back").onclick = () => { location.href = "/"; };
      return;
    }
    currentUser = u;
    let storage;
    try { storage = window.localStorage; } catch {}
    dailySync = createDailySync({ userId: u.id, post: postDailySync, storage, locks: navigator.locks });
    window.addEventListener("online", dailySync.flush);
    void dailySync.flush();
    await showHome();
  } catch (e) {
    render($(`<section><p class="bad">网络出错了：${escapeHtml(e.message)}</p><button class="big" onclick="location.reload()">重试</button></section>`));
  }
})();
