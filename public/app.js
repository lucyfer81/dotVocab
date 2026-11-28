import { shouldRejectInputType, sanitizeValue, renderMirrorHtml, diffHtml } from "./spell-helpers.js";
import { sfx } from "./sfx.js";
import { showConfirm, showToast } from "./ui.js";
import { createTtsPlayer } from "./tts-player.js";
import { recordDailyAnswer, recordPracticeAnswer, scheduleDailyItems } from "./review-client.js";
import { slugFromPath, nameForSlug, resolveUser, SLUG_BY_NAME } from "./user-routing.js";

const API = "/api";
let currentUser;

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

// ---------- 每日任务：POST /daily/open + /daily/answer（服务端判定） ----------
async function startDailySession() {
  tts.unlock(); // 还在手势调用栈内：借一次静音播放换取整局自动读音权限
  let opened;
  try {
    opened = await postJson("/daily/open", { userId: currentUser.id });
  } catch (e) {
    renderLoadError("今日任务", e);
    return;
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
  await runDailySession(opened);
}

async function runDailySession(opened) {
  const title = "今日任务";
  const items = opened.items;
  const total = items.length;
  const statusById = new Map(items.map((i) => [i.id, i.status]));
  // 恢复/调度规则：跳过 done；correction 排在其他待练词之后（只剩错词时立即订正）
  const queue = scheduleDailyItems(items);
  let completed = total - queue.length; // 进度按不同条目计数，不按尝试次数
  let stars = 0;
  let firstRight = 0; // 首次独立拼对的条目数（订正不计）
  let streak = 0;     // 连击：连续答对数
  let aborted = false;
  let study = null;
  let actionHandler = null;
  let currentReveal = null; // 当前卡的「先看答案」动作（ensureStudy 只建一次 DOM）

  if (queue.length === 0) {
    render($(`<section><h2>${escapeHtml(title)}</h2><p>今天的任务已经全部完成啦 🎉 明天再来吧！</p>
      <button class="big" id="back">返回基地</button></section>`));
    document.getElementById("back").onclick = showHome;
    return;
  }

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
    };
    return study;
  }

  function showStaleDay() {
    aborted = true;
    stopSpeak();
    render($(`<section><h2>🌙 清单已过日</h2>
      <p>这份清单是昨天打开的。进度已经保存，重新打开今天的清单继续吧！</p>
      <button class="big" id="reopen">打开今日清单</button>
      <button class="link" id="back">返回基地</button></section>`));
    document.getElementById("reopen").onclick = () => startDailySession();
    document.getElementById("back").onclick = showHome;
  }

  // 服务端返回的 item.status 是权威（迟到设备可能拿到 stage=correction，直接采纳）
  function markStatus(item, prevStatus) {
    statusById.set(item.id, item.status);
    if (item.status === "done" && prevStatus !== "done") completed++;
  }

  // 条目转入订正：按调度规则排到其他待练词之后（队列尾）；队列空时立即订正
  function requeueCorrection(itemView) {
    queue.push(itemView);
  }

  await nextCard();

  async function nextCard() {
    if (aborted) return;
    const w = queue.shift();
    if (!w) return finish();
    updateProgress();
    spellingCard(w);
  }

  function spellingCard(w) {
    const s = ensureStudy();
    let cardStatus = statusById.get(w.id) ?? "pending";
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

    function applyResult(resp, raw) {
      stars += resp.starsAwarded || 0;
      const wasDone = cardStatus === "done";
      markStatus(resp.item, cardStatus);
      cardStatus = resp.item.status;
      updateProgress();
      if (resp.correct === true) {
        if (!wasDone && resp.stage === "first") firstRight++;
        streak++;
        const combo = streak >= 3 ? `<span class="combo">🔥 连击 x${streak}</span>` : "";
        const star = resp.starsAwarded > 0 ? " ⭐" : "";
        s.fb.innerHTML = `<div><span class="ok">✅ 对！${star}</span>${combo}</div>`;
        sfx.correct();
        // 时序：判定先出 → 读音在静态卡片上播完（不与动画重叠，避免 iOS 机械音
        // 阻塞主线程冻住动画）→ launch 动画送走卡片 → 动画放完才出现下一个词
        const spoken = speak(resp.item.term);
        Promise.all([delay(500), spoken]).then(async () => {
          if (aborted) return;
          s.wordcard.classList.add("launch");
          await waitForLaunch(s.wordcard);
          if (!aborted) nextCard();
        });
      } else {
        streak = 0;
        const cmp = diffHtml(resp.item.term.toLowerCase(), String(raw ?? "").toLowerCase());
        s.fb.innerHTML = `<div><span class="bad">🚀 差一点点！正确：<span class="cmp">${cmp}</span></span></div>`;
        s.wordcard.classList.add("shake");
        sfx.wrong();
        speak(resp.item.term); // 与阅读正确拼写并行；点「下一题」立即打断残留读音
        if (cardStatus === "correction") requeueCorrection(resp.item);
        s.action.textContent = "下一题";
        actionHandler = () => { if (!aborted) { stopSpeak(); nextCard(); } }; // 孩子操作优先
      }
    }

    async function submitSpell() {
      if (submitted) return;
      submitted = true;
      const raw = s.inp.value.trim();
      actionHandler = null; // 反馈期间按钮/Enter 不再响应
      s.fb.innerHTML = `<div><span class="muted">🛰️ 正在核对…</span></div>`;
      await recordDailyAnswer({
        post: postJson,
        userId: currentUser.id,
        itemId: w.id,
        action: "spell",
        answer: raw,
        onResult: (resp) => applyResult(resp, raw),
        onError: () => {
          // 网络类失败：客户端已用同一 eventId 自动重试过一次，这里允许手动再试
          submitted = false;
          s.fb.innerHTML = `<div><span class="bad">😵 网络开小差了，再提交一次吧</span></div>`;
          s.action.textContent = "提交";
          actionHandler = submitSpell;
        },
        onConflict: () => showStaleDay(), // 过上海午夜：本地不再重试该事件
      });
    }

    // 主动揭示：action='reveal'（首次看答案记 Again；订正中的揭示记一次失败订正）。
    // 揭示后留在本卡，孩子随即把已知答案拼对即完成订正。
    currentReveal = function revealWord() {
      if (submitted) return;
      submitted = true;
      actionHandler = null;
      s.reveal.disabled = true;
      s.fb.innerHTML = `<div><span class="muted">🛰️ 正在记录…</span></div>`;
      recordDailyAnswer({
        post: postJson,
        userId: currentUser.id,
        itemId: w.id,
        action: "reveal",
        onResult: (resp) => {
          markStatus(resp.item, cardStatus);
          cardStatus = resp.item.status;
          updateProgress();
          s.fb.innerHTML = `<div><span class="muted">👀 答案是：<span class="cmp">${escapeHtml(resp.item.term)}</span></span>
            <p><small>先记一次小失误，把它拼对就算订正成功！</small></p></div>`;
          sfx.wrong();
          speak(resp.item.term);
          s.inp.value = "";
          s.spellRender();
          s.inp.focus();
          s.action.textContent = "提交";
          submitted = false; // 立即拼写订正
          actionHandler = submitSpell;
        },
        onError: () => {
          submitted = false;
          s.reveal.disabled = false;
          s.fb.innerHTML = `<div><span class="bad">😵 网络开小差了，稍后再试</span></div>`;
          s.action.textContent = "提交";
          actionHandler = submitSpell;
        },
        onConflict: () => showStaleDay(),
      });
    };

    actionHandler = submitSpell;
  }

  function finish() {
    study = null; // 本局结束：学习界面随庆祝页整体替换，键盘可以收起
    const card = $(`<section class="study">
      <h2>🛬 着陆成功！</h2>
      <p>完成 ${completed} 个任务，独立拼对 ${firstRight} 个，获得 ⭐ x ${stars}！</p>
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
    await showHome();
  } catch (e) {
    render($(`<section><p class="bad">网络出错了：${escapeHtml(e.message)}</p><button class="big" onclick="location.reload()">重试</button></section>`));
  }
})();
