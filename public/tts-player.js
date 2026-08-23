// ---------- 太空发音控制台 ----------
// 单个 <audio> 元素复用；任何新朗读立即打断旧朗读（杜绝串词）；
// speak() 返回 Promise，在朗读真正结束（或 4s 兜底）后 resolve，绝不 reject，
// 这样"提交后读音"可以赶在下一个单词出现之前播完。
//
// 关键不变量：每个 speak() 调用持有自己的 invocation 对象，所有异步回调
// （play() 拒绝、error 事件、utterance end、4s 超时）只允许作用于"自己
// 仍是 current"的调用——被打断的旧调用的迟到事件一律忽略，否则会暂停
// 新音频、错误切换机械音、或提前放行新调用（实测引发过串词+动画卡死）。

export const TTS_MAX_WAIT_MS = 4000;
export const TTS_PREFETCH_CONCURRENCY = 3;

const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

export function ttsUrl(text) {
  return `/api/tts?term=${encodeURIComponent(text)}&lang=en-US`;
}

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
  const fetcher = env.fetchImpl || ((url) => fetch(url));
  const createObjectURL =
    env.createObjectURL || ((blob) => URL.createObjectURL(blob));

  let audio = null;
  let current = null; // 本次调用自己的状态；被打断后所有迟到回调失效
  const prefetched = new Set(); // 已预取过的词
  const blobUrls = new Map(); // term -> blob: URL，预取成功后 speak() 零网络秒起播

  function ensureAudio() {
    if (!audio) audio = newAudio();
    return audio;
  }

  function cancelSynth() {
    if (!synth) return;
    try { synth.cancel(); } catch {}
  }

  function stopAudio() {
    if (!audio) return;
    try { audio.pause(); } catch {}
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

      const invocation = {
        settled: false,
        fellBack: false,
        resolve: resolveP,
        timerId: 0,
        detach() {
          a.removeEventListener("ended", onEnded);
          a.removeEventListener("error", onError);
        },
      };

      const isMine = () => current === invocation && !invocation.settled;

      function fallback() {
        if (!isMine() || invocation.fellBack) return;
        invocation.fellBack = true;
        stopAudio(); // 加载失败/被拦截：停掉元素，防止迟到的声音串词
        if (synth) {
          // 合成/网络失败：回退浏览器机械音，保证按钮永不哑
          const u = newUtterance(text);
          u.lang = "en-US";
          u.onend = () => { if (isMine()) settle(); };
          u.onerror = () => { if (isMine()) settle(); };
          try { synth.speak(u); } catch { settle(); }
        } else {
          settle(); // 任何通道都不可用：立即放行，流程绝不卡死
        }
      }

      invocation.timerId = setTimer(() => {
        if (!isMine()) return;
        stopAudio();
        settle();
      }, TTS_MAX_WAIT_MS);
      current = invocation;
      a.src = blobUrls.get(text) || ttsUrl(text); // 命中预取：blob 秒起播，否则走网络
      const playP = a.play();
      if (playP && playP.catch) playP.catch(() => fallback());
      return promise;
    },

    stop() {
      settle();
      stopAudio();
      cancelSynth();
    },

    // 预取一批词的音频（只下载不出声）：成功后持有 blob URL，
    // speak() 时零网络秒起播，消除首次读音的合成/网络延迟。
    // 媒体元素走 Range 请求不会复用普通 HTTP 缓存，所以必须自己持有 blob。
    async prefetch(terms) {
      const todo = [];
      for (const t of terms) {
        if (!prefetched.has(t)) { prefetched.add(t); todo.push(t); }
      }
      let i = 0;
      const worker = async () => {
        while (i < todo.length) {
          const term = todo[i++];
          try {
            const res = await fetcher(ttsUrl(term));
            if (res && res.ok) {
              const blob = await res.blob();
              blobUrls.set(term, createObjectURL(blob));
            }
          } catch {} // 失败静默：真正播放时走网络 URL + 机械音回退
        }
      };
      await Promise.all(Array.from({ length: Math.min(TTS_PREFETCH_CONCURRENCY, todo.length) }, worker));
    },
  };
}
