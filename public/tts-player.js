// ---------- 太空发音控制台 ----------
// 单个 <audio> 元素复用；任何新朗读立即打断旧朗读（杜绝串词）；
// speak() 返回 Promise，在朗读真正结束（或 4s 兜底）后 resolve，绝不 reject，
// 这样"提交后读音"可以赶在下一个单词出现之前播完。

export const TTS_MAX_WAIT_MS = 4000;

const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

export function createTtsPlayer(env = {}) {
  const newAudio = env.newAudio || (() => new Audio());
  const synth =
    env.speechSynthesis !== undefined
      ? env.speechSynthesis
      : typeof window !== "undefined" && "speechSynthesis" in window
        ? window.speechSynthesis
        : null;
  const newUtterance = env.newUtterance || ((text) => new SpeechSynthesisUtterance(text));
  const setTimer = env.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = env.clearTimeout || ((id) => clearTimeout(id));

  let audio = null;
  let current = null; // { settled, resolve, timerId, detach, fellBack }

  function ensureAudio() {
    if (!audio) audio = newAudio();
    return audio;
  }

  function cancelSynth() {
    if (!synth) return;
    try { synth.cancel(); } catch {}
  }

  function settle() {
    if (!current || current.settled) return;
    current.settled = true;
    clearTimer(current.timerId);
    current.detach();
    const resolve = current.resolve;
    current = null;
    resolve();
  }

  function stopAudio() {
    if (!audio) return;
    try { audio.pause(); } catch {}
  }

  return {
    // 进入学习时在手势调用栈内调用：播放一段极短静音，换取后续自动读音权限
    unlock() {
      try {
        const a = ensureAudio();
        a.src = SILENT_WAV;
        const p = a.play();
        if (p && p.catch) p.catch(() => {});
      } catch {}
    },

    speak(text) {
      settle(); // 打断旧朗读：旧的 promise 立即放行，不会悬挂
      cancelSynth();
      const a = ensureAudio();
      let resolveP;
      const promise = new Promise((r) => { resolveP = r; });

      const onEnded = () => settle();
      const onError = () => fallback();
      a.addEventListener("ended", onEnded);
      a.addEventListener("error", onError);

      function fallback() {
        if (!current || current.settled || current.fellBack) return;
        current.fellBack = true;
        stopAudio(); // 加载失败/被拦截：停掉元素，防止迟到的声音串词
        if (synth) {
          // 合成/网络失败：回退浏览器机械音，保证按钮永不哑
          const u = newUtterance(text);
          u.lang = "en-US";
          u.onend = () => settle();
          u.onerror = () => settle();
          try { synth.speak(u); } catch { settle(); }
        } else {
          settle(); // 任何通道都不可用：立即放行，流程绝不卡死
        }
      }

      const timerId = setTimer(() => { stopAudio(); settle(); }, TTS_MAX_WAIT_MS);
      current = {
        settled: false,
        resolve: resolveP,
        timerId,
        fellBack: false,
        detach() {
          a.removeEventListener("ended", onEnded);
          a.removeEventListener("error", onError);
        },
      };
      a.src = `/api/tts?term=${encodeURIComponent(text)}&lang=en-US`;
      const playP = a.play();
      if (playP && playP.catch) playP.catch(() => fallback());
      return promise;
    },

    stop() {
      settle();
      stopAudio();
      cancelSynth();
    },
  };
}
