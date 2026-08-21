// ---------- 太空任务音效：Web Audio 合成，零资源文件，失败静默 ----------
// iOS 要求首次用户手势后才能出声：首次 pointerdown 自动 unlock。
let ctx = null;

function ensureCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

function tone(freq, delay, dur, type = "triangle", vol = 0.1) {
  const c = ensureCtx();
  if (!c) return;
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(vol, t0 + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

export const sfx = {
  correct() { try { tone(660, 0, 0.12); tone(880, 0.1, 0.18); } catch {} },
  wrong()   { try { tone(196, 0, 0.22, "sawtooth", 0.07); tone(147, 0.14, 0.28, "sawtooth", 0.07); } catch {} },
  finish()  { try { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.13, 0.3)); } catch {} },
};

let unlocked = false;
document.addEventListener("pointerdown", () => {
  if (unlocked) return;
  unlocked = true;
  try { ensureCtx(); } catch {}
}, { once: false, capture: true });
