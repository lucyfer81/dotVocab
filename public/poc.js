// POC 实验页逻辑:按住录音 → 上传 /api/poc/asr → 样本存 localStorage → 汇总统计。
// 独立文件,验收后随 public/poc.html 一起删除。
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const WORDS = [
  "cat", "dog", "sun", "hat", "bed", "cup", "box", "red", "big", "run",
  "apple", "fish", "star", "tree", "book", "milk", "jump", "cake", "ball", "bird",
];
const LS_KEY = "poc_asr_samples_v1";

const $ = (id) => document.getElementById(id);

const state = {
  mode: "letter",
  target: "A",
  recording: false,
  uploading: false,
  stream: null,
  recorder: null,
  chunks: [],
  mime: null,
  audioCtx: null,
  analyser: null,
  raf: 0,
};

/* ---------- 工具 ---------- */

function loadSamples() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveSamples(samples) {
  localStorage.setItem(LS_KEY, JSON.stringify(samples));
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)));
  return sorted[idx];
}

// 裸匹配(无约束基线):去掉非字母字符后整串比对,模拟"不知道目标词"的朴素判定。
function rawMatch(mode, expected, text) {
  const heard = (text || "").replace(/[^a-zA-Z]/g, "");
  const want = (expected || "").replace(/[^a-zA-Z]/g, "");
  if (!want) return false;
  return mode === "letter"
    ? heard.toUpperCase() === want.toUpperCase()
    : heard.toLowerCase() === want.toLowerCase();
}

/* ---------- 题目 ---------- */

function nextTarget() {
  const pool = state.mode === "word" ? WORDS : LETTERS;
  let t = pool[Math.floor(Math.random() * pool.length)];
  if (pool.length > 1) {
    while (t === state.target) t = pool[Math.floor(Math.random() * pool.length)];
  }
  state.target = t;
  $("target").textContent = t;
  $("prompt-tip").textContent =
    state.mode === "word" ? "请朗读屏幕上的整个单词" : "请读出屏幕上的字母";
  $("result").hidden = true;
}

function setMode(mode) {
  state.mode = mode;
  $("mode-letter").classList.toggle("active", mode === "letter");
  $("mode-word").classList.toggle("active", mode === "word");
  nextTarget();
}

/* ---------- 录音 ---------- */

function pickMime() {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const m of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch { /* 忽略个别浏览器对 isTypeSupported 的异常 */ }
  }
  return null;
}

async function ensureStream() {
  if (state.stream && state.stream.active) return;
  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  state.mime = state.mime ?? pickMime();
  // 音量表:AudioContext 必须在手势里创建/恢复(iOS Safari 要求)
  state.audioCtx = state.audioCtx ?? new (window.AudioContext || window.webkitAudioContext)();
  if (state.audioCtx.state === "suspended") await state.audioCtx.resume();
  const src = state.audioCtx.createMediaStreamSource(state.stream);
  state.analyser = state.audioCtx.createAnalyser();
  state.analyser.fftSize = 512;
  src.connect(state.analyser);
}

function startMeter() {
  const meter = $("meter");
  const buf = new Uint8Array(state.analyser ? state.analyser.fftSize : 0);
  const tick = () => {
    if (!state.recording || !state.analyser) return;
    state.analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) {
      const d = (v - 128) / 128;
      sum += d * d;
    }
    const rms = Math.sqrt(sum / (buf.length || 1));
    meter.style.width = Math.min(100, Math.round(rms * 320)) + "%";
    state.raf = requestAnimationFrame(tick);
  };
  state.raf = requestAnimationFrame(tick);
}

function stopMeter() {
  cancelAnimationFrame(state.raf);
  $("meter").style.width = "0%";
}

function setStatus(msg) {
  $("status").textContent = msg;
}

function updateRecBtn() {
  const btn = $("rec");
  btn.classList.toggle("recording", state.recording);
  btn.textContent = state.recording ? "🔴 录音中…松开停止" : "🎙️ 按住说,松开停";
  btn.disabled = state.uploading;
}

async function startRecording() {
  if (state.recording || state.uploading) return;
  try {
    await ensureStream();
  } catch (e) {
    setStatus("无法访问麦克风:" + e.message);
    return;
  }
  state.chunks = [];
  const opts = state.mime ? { mimeType: state.mime } : undefined;
  state.recorder = new MediaRecorder(state.stream, opts);
  state.recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) state.chunks.push(e.data);
  };
  state.recorder.onstop = onStopped;
  state.recorder.start();
  state.recording = true;
  setStatus("录音中…");
  updateRecBtn();
  startMeter();
}

function stopRecording() {
  if (!state.recording) return;
  state.recording = false;
  stopMeter();
  updateRecBtn();
  try {
    state.recorder.stop();
  } catch { /* 已停止则忽略 */ }
}

async function onStopped() {
  const type = (state.recorder && state.recorder.mimeType) || state.mime || "audio/mp4";
  const blob = new Blob(state.chunks, { type });
  if (!blob.size) {
    setStatus("没有录到声音,请重试");
    return;
  }
  await upload(blob);
}

/* ---------- 上传与记录 ---------- */

async function upload(blob) {
  state.uploading = true;
  updateRecBtn();
  setStatus("识别中…");
  const t0 = performance.now();
  try {
    const res = await fetch(
      `/api/poc/asr?mode=${state.mode}&expected=${encodeURIComponent(state.target)}`,
      {
        method: "POST",
        headers: { "Content-Type": blob.type || "audio/mp4" },
        body: blob,
      },
    );
    const latencyClient = Math.round(performance.now() - t0);
    const data = await res.json();
    if (!res.ok) {
      setStatus(`识别失败(${data.error ?? res.status}),音频格式:${blob.type}`);
      return;
    }
    recordSample(data, latencyClient);
    renderResult(data, latencyClient);
    setStatus(`完成 · 下一样本 #${loadSamples().length}`);
    setTimeout(nextTarget, 1500);
  } catch (e) {
    setStatus("上传失败:" + e.message);
  } finally {
    state.uploading = false;
    updateRecBtn();
  }
}

function recordSample(data, latencyClient) {
  const samples = loadSamples();
  samples.push({
    ts: Date.now(),
    provider: "azure",
    mode: state.mode,
    expected: state.target,
    heard: data.text,
    normalized: data.normalized,
    raw_match: rawMatch(state.mode, state.target, data.text),
    constrained_match: data.match,
    latency_client_ms: latencyClient,
    latency_azure_ms: data.ms_worker_to_azure,
  });
  saveSamples(samples);
  renderSummary();
}

function renderResult(data, latencyClient) {
  $("result").hidden = false;
  $("heard").textContent = data.text || "(空)";
  const verdict = $("verdict");
  const expected = state.target.toUpperCase();
  if (data.match) {
    verdict.innerHTML = `<span class="verdict-ok">✓ 约束匹配 ${expected}</span>`;
  } else if (rawMatch(state.mode, state.target, data.text)) {
    verdict.innerHTML = `<span class="verdict-ok">✓ 原文精确命中 ${expected}(约束未命中)</span>`;
  } else {
    verdict.innerHTML = `<span class="verdict-bad">✗ 目标 ${expected} · 归一化 ${
      data.normalized ?? "(无)"
    }</span>`;
  }
  $("ms-client").textContent = latencyClient;
  $("ms-azure").textContent = data.ms_worker_to_azure;
}

/* ---------- 汇总 ---------- */

function summaryOf(samples) {
  const n = samples.length;
  const rawOk = samples.filter((s) => s.raw_match).length;
  const cOk = samples.filter((s) => s.constrained_match).length;
  const latC = samples.map((s) => s.latency_client_ms).filter((v) => typeof v === "number").sort((a, b) => a - b);
  const latA = samples.map((s) => s.latency_azure_ms).filter((v) => typeof v === "number").sort((a, b) => a - b);
  return {
    n,
    rawAcc: n ? Math.round((rawOk / n) * 100) : null,
    constrainedAcc: n ? Math.round((cOk / n) * 100) : null,
    p50Client: percentile(latC, 0.5),
    p95Client: percentile(latC, 0.95),
    p50Azure: percentile(latA, 0.5),
    p95Azure: percentile(latA, 0.95),
  };
}

function stat(label, value) {
  return `<div class="poc-stat">${label}<br><b>${value}</b></div>`;
}

function renderSummary() {
  // 本页只统计 Azure 样本(provider=cf 的 POC1 样本在 /poc1 汇总)
  const all = loadSamples().filter((s) => (s.provider ?? "azure") !== "cf");
  const letters = all.filter((s) => s.mode === "letter");
  const words = all.filter((s) => s.mode === "word");
  const sl = summaryOf(letters);
  const sw = summaryOf(words);
  const html = [
    stat("字母·次数", sl.n),
    stat("字母·裸准确率", sl.rawAcc === null ? "—" : sl.rawAcc + "%"),
    stat("字母·约束后", sl.constrainedAcc === null ? "—" : sl.constrainedAcc + "%"),
    stat("单词·次数", sw.n),
    stat("单词·裸准确率", sw.rawAcc === null ? "—" : sw.rawAcc + "%"),
    stat("单词·约束后", sw.constrainedAcc === null ? "—" : sw.constrainedAcc + "%"),
    stat("端到端 P50/P95", sl.n + sw.n === 0 ? "—" : `${summaryOf(all).p50Client}/${summaryOf(all).p95Client} ms`),
    stat("Azure P50/P95", sl.n + sw.n === 0 ? "—" : `${summaryOf(all).p50Azure}/${summaryOf(all).p95Azure} ms`),
  ];
  $("summary").innerHTML = html.join("");

  // 混淆矩阵(仅字母模式):按 expected 分组统计 heard 分布
  const byExpected = new Map();
  for (const s of letters) {
    const heard = s.normalized ?? (s.heard && s.heard.trim() ? s.heard.trim().slice(0, 12) : "∅");
    const key = s.expected.toUpperCase();
    if (!byExpected.has(key)) byExpected.set(key, new Map());
    const m = byExpected.get(key);
    m.set(heard, (m.get(heard) || 0) + 1);
  }
  const lines = [...byExpected.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([exp, m]) => {
      const parts = [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([heard, cnt]) => `${heard}×${cnt}`);
      return `${exp}: ${parts.join("  ")}`;
    });
  $("matrix").textContent = lines.length
    ? "混淆矩阵(expected → heard)\n" + lines.join("\n")
    : "";
}

/* ---------- 数据操作 ---------- */

function exportJson() {
  const samples = loadSamples();
  const blob = new Blob([JSON.stringify(samples, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `poc-asr-samples-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function clearAll() {
  if (!confirm("确认清空全部 POC 样本数据?")) return;
  localStorage.removeItem(LS_KEY);
  renderSummary();
  setStatus("已清空");
}

function releaseMic() {
  stopRecording();
  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop();
    state.stream = null;
  }
  if (state.audioCtx) {
    state.audioCtx.close().catch(() => {});
    state.audioCtx = null;
    state.analyser = null;
  }
  setStatus("麦克风已释放,下次按下重新获取");
}

/* ---------- 绑定 ---------- */

const rec = $("rec");
rec.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  rec.setPointerCapture(e.pointerId);
  startRecording();
});
rec.addEventListener("pointerup", (e) => {
  e.preventDefault();
  stopRecording();
});
rec.addEventListener("pointercancel", stopRecording);
rec.addEventListener("contextmenu", (e) => e.preventDefault());

$("next").addEventListener("click", nextTarget);
$("mode-letter").addEventListener("click", () => setMode("letter"));
$("mode-word").addEventListener("click", () => setMode("word"));
$("export").addEventListener("click", exportJson);
$("clear").addEventListener("click", clearAll);
$("release").addEventListener("click", releaseMic);

if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
  setStatus("此浏览器不支持 MediaRecorder / getUserMedia,无法测试");
  rec.disabled = true;
}

renderSummary();
