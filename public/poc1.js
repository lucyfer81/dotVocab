// POC1:Cloudflare Workers AI whisper 对照。录音 → 前端转 16kHz 单声道 WAV →
// /api/poc1/asr → 样本与 Azure 共用 localStorage(provider 字段区分)。
// 验收后随 public/poc1.html 一起删除。
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const WORDS = [
  "cat", "dog", "sun", "hat", "bed", "cup", "box", "red", "big", "run",
  "apple", "fish", "star", "tree", "book", "milk", "jump", "cake", "ball", "bird",
];
const LS_KEY = "poc_asr_samples_v1";

const $ = (id) => document.getElementById(id);

const state = {
  mode: "letter",
  model: "whisper-large-v3-turbo",
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
  peakRms: 0,
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

function setModel(model) {
  state.model = model;
  $("model-turbo").classList.toggle("active", model === "whisper-large-v3-turbo");
  $("model-base").classList.toggle("active", model === "whisper");
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
    if (rms > state.peakRms) state.peakRms = rms;
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
  state.peakRms = 0;
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
  // 音量门限:whisper 对无语音音频会产生幻觉文本,峰值过低直接不上传
  if (state.peakRms < 0.01) {
    setStatus("音量太低,没有上传——请贴近麦克风大声读");
    return;
  }
  await upload(blob);
}

/* ---------- WAV 转换(whisper 输入统一为 16kHz/16bit 单声道) ---------- */

async function toWav(blob) {
  const raw = await blob.arrayBuffer();
  // decodeAudioData 会消费/detach buffer,Safari 上尤甚,先拷贝一份
  const decoded = await state.audioCtx.decodeAudioData(raw.slice(0));
  const rate = 16000;
  const frames = Math.max(1, Math.ceil(decoded.duration * rate));
  const offline = new OfflineAudioContext(1, frames, rate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  const chan = rendered.getChannelData(0);

  const bytes = new DataView(new ArrayBuffer(44 + chan.length * 2));
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) bytes.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  bytes.setUint32(4, 36 + chan.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  bytes.setUint32(16, 16, true);   // PCM chunk size
  bytes.setUint16(20, 1, true);    // PCM
  bytes.setUint16(22, 1, true);    // mono
  bytes.setUint32(24, rate, true);
  bytes.setUint32(28, rate * 2, true); // byte rate
  bytes.setUint16(32, 2, true);    // block align
  bytes.setUint16(34, 16, true);   // bits per sample
  writeStr(36, "data");
  bytes.setUint32(40, chan.length * 2, true);
  let off = 44;
  for (let i = 0; i < chan.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, chan[i]));
    bytes.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([bytes.buffer], { type: "audio/wav" });
}

/* ---------- 上传与记录 ---------- */

async function upload(blob) {
  state.uploading = true;
  updateRecBtn();
  setStatus("转换 WAV 中…");
  let wav;
  let latencyConvert = 0;
  try {
    const tc = performance.now();
    wav = await toWav(blob);
    latencyConvert = Math.round(performance.now() - tc);
  } catch (e) {
    setStatus("音频转换失败:" + e.message);
    state.uploading = false;
    updateRecBtn();
    return;
  }
  setStatus("识别中…");
  const t0 = performance.now();
  try {
    const res = await fetch(
      `/api/poc1/asr?mode=${state.mode}&expected=${encodeURIComponent(state.target)}&model=${state.model}`,
      {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: wav,
      },
    );
    const latencyClient = Math.round(performance.now() - t0);
    const data = await res.json();
    if (!res.ok) {
      setStatus(`识别失败(${data.error ?? res.status})`);
      return;
    }
    recordSample(data, latencyClient, latencyConvert);
    renderResult(data, latencyClient, latencyConvert);
    setStatus(`完成 · 样本 #${loadSamples().length}`);
    setTimeout(nextTarget, 1500);
  } catch (e) {
    setStatus("上传失败:" + e.message);
  } finally {
    state.uploading = false;
    updateRecBtn();
  }
}

function recordSample(data, latencyClient, latencyConvert) {
  const samples = loadSamples();
  samples.push({
    ts: Date.now(),
    provider: "cf",
    model: data.model,
    mode: state.mode,
    expected: state.target,
    heard: data.text,
    normalized: data.normalized,
    raw_match: rawMatch(state.mode, state.target, data.text),
    constrained_match: data.match,
    latency_convert_ms: latencyConvert,
    latency_client_ms: latencyClient,
    latency_model_ms: data.ms_model,
  });
  saveSamples(samples);
  renderSummary();
}

function renderResult(data, latencyClient, latencyConvert) {
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
  $("ms-client").textContent = latencyClient + latencyConvert;
  $("ms-convert").textContent = latencyConvert;
  $("ms-model").textContent = data.ms_model;
}

/* ---------- 汇总:CF 分模型 vs Azure ---------- */

function summaryOf(samples, e2eOf) {
  const n = samples.length;
  const rawOk = samples.filter((s) => s.raw_match).length;
  const cOk = samples.filter((s) => s.constrained_match).length;
  const lat = samples.map(e2eOf).filter((v) => typeof v === "number").sort((a, b) => a - b);
  return {
    n,
    rawAcc: n ? Math.round((rawOk / n) * 100) : null,
    constrainedAcc: n ? Math.round((cOk / n) * 100) : null,
    p50: percentile(lat, 0.5),
    p95: percentile(lat, 0.95),
  };
}

const cfE2E = (s) => (s.latency_convert_ms || 0) + (s.latency_client_ms || 0);
const azE2E = (s) => s.latency_client_ms || 0;

function stat(label, s, suffix = "") {
  const acc = s.n ? `裸${s.rawAcc}%/约束${s.constrainedAcc}%` : "—";
  const lat = s.n ? `P50 ${s.p50}/P95 ${s.p95}ms` : "—";
  return `<div class="poc-stat">${label}${suffix}<br><b>${s.n}</b> 次 · ${acc}<br>${lat}</div>`;
}

function renderSummary() {
  const all = loadSamples();
  const cf = all.filter((s) => s.provider === "cf");
  const az = all.filter((s) => s.provider !== "cf"); // 旧样本无 provider 字段,视为 azure
  const groups = [
    ["turbo·字母", cf.filter((s) => s.model !== "whisper" && s.mode === "letter"), cfE2E],
    ["base·字母", cf.filter((s) => s.model === "whisper" && s.mode === "letter"), cfE2E],
    ["turbo·单词", cf.filter((s) => s.model !== "whisper" && s.mode === "word"), cfE2E],
    ["base·单词", cf.filter((s) => s.model === "whisper" && s.mode === "word"), cfE2E],
    ["azure·字母", az.filter((s) => s.mode === "letter"), azE2E],
    ["azure·单词", az.filter((s) => s.mode === "word"), azE2E],
  ];
  $("summary").innerHTML = groups
    .map(([label, samples, e2e]) => stat(label, summaryOf(samples, e2e)))
    .join("");

  // 混淆矩阵(CF 字母模式,按模型标注)
  const byKey = new Map();
  for (const s of cf.filter((x) => x.mode === "letter")) {
    const heard = s.normalized ?? (s.heard && s.heard.trim() ? s.heard.trim().slice(0, 12) : "∅");
    const key = `${s.model === "whisper" ? "base" : "turbo"}|${s.expected.toUpperCase()}`;
    if (!byKey.has(key)) byKey.set(key, new Map());
    const m = byKey.get(key);
    m.set(heard, (m.get(heard) || 0) + 1);
  }
  const lines = [...byKey.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, m]) => {
      const [model, exp] = key.split("|");
      const parts = [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([heard, cnt]) => `${heard}×${cnt}`);
      return `[${model}] ${exp}: ${parts.join("  ")}`;
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
  a.download = `poc-asr-samples-cf-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function clearAll() {
  if (!confirm("确认清空全部 POC 样本数据(含 Azure 样本)?")) return;
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
$("model-turbo").addEventListener("click", () => setModel("whisper-large-v3-turbo"));
$("model-base").addEventListener("click", () => setModel("whisper"));
$("export").addEventListener("click", exportJson);
$("clear").addEventListener("click", clearAll);
$("release").addEventListener("click", releaseMic);

if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
  setStatus("此浏览器不支持 MediaRecorder / getUserMedia,无法测试");
  rec.disabled = true;
}

renderSummary();
