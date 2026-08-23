import { describe, it, expect } from "vitest";
import { createTtsPlayer, TTS_MAX_WAIT_MS } from "../public/tts-player.js";

// ---------- 测试替身：音频元素 / 语音合成 / 定时器 ----------
type Listener = (ev: unknown) => void;

interface FakeAudio {
  src: string;
  playCalls: number;
  paused: boolean;
  play(): Promise<void>;
  pause(): void;
  addEventListener(ev: string, fn: Listener): void;
  removeEventListener(ev: string, fn: Listener): void;
  dispatch(ev: string): void;
}

function makeFakeAudio(opts: { playResult?: Promise<void> | "reject" } = {}): FakeAudio {
  const listeners: Record<string, Listener[]> = {};
  const audio: FakeAudio = {
    src: "",
    playCalls: 0,
    paused: false,
    play() {
      audio.playCalls++;
      if (opts.playResult === "reject") return Promise.reject(new Error("not allowed"));
      // Promise 型结果只作用于第一次 play()：模拟"第一次加载被中止拒绝，后续播放成功"
      if (opts.playResult instanceof Promise && audio.playCalls === 1) return opts.playResult;
      return Promise.resolve();
    },
    pause() { audio.paused = true; },
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    removeEventListener(ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); },
    dispatch(ev) { (listeners[ev] || []).forEach((fn) => fn({})); },
  };
  return audio;
}

interface FakeUtterance { text: string; lang?: string; onend: (() => void) | null; onerror: (() => void) | null }

function makeFakeSynth() {
  const utterances: FakeUtterance[] = [];
  return {
    utterances,
    cancelCalls: 0,
    speak(u: FakeUtterance) { utterances.push(u); },
    cancel() { (this as { cancelCalls: number }).cancelCalls++; },
  };
}

function makeFakeTimers() {
  let seq = 0;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  const timers = {
    set(fn: () => void, ms: number) { const id = ++seq; pending.set(id, { fn, ms }); return id; },
    clear(id: number) { pending.delete(id); },
    fire(id: number) { const t = pending.get(id); if (!t) return false; pending.delete(id); t.fn(); return true; },
    fireAll() { [...pending.keys()].forEach((id) => timers.fire(id)); },
    msOf(id: number) { return pending.get(id)?.ms },
    size() { return pending.size },
  };
  return timers;
}

function makeEnv(overrides: {
  audio?: FakeAudio;
  synth?: ReturnType<typeof makeFakeSynth> | null;
  timers?: ReturnType<typeof makeFakeTimers>;
  fetchImpl?: (url: string) => Promise<unknown>;
  createObjectURL?: (b: unknown) => string;
} = {}) {
  const audio = overrides.audio || makeFakeAudio();
  const synth = overrides.synth === undefined ? makeFakeSynth() : overrides.synth;
  const timers = overrides.timers || makeFakeTimers();
  const player = createTtsPlayer({
    newAudio: () => audio,
    speechSynthesis: synth,
    newUtterance: (text: string): FakeUtterance => ({ text, onend: null, onerror: null }),
    setTimeout: timers.set.bind(timers),
    clearTimeout: timers.clear.bind(timers),
    fetchImpl: overrides.fetchImpl,
    createObjectURL: overrides.createObjectURL,
  });
  return { player, audio, synth, timers };
}

// ---------- speak：生命周期 ----------
describe("tts player", () => {
  it("resolves speak() when the audio ends", async () => {
    const { player, audio } = makeEnv();
    const p = player.speak("cat");
    audio.dispatch("ended");
    await p; // 不悬挂即通过
  });

  it("requests the term URL with en-US lang", async () => {
    const { player, audio } = makeEnv();
    const p = player.speak("ice cream");
    expect(audio.src).toBe(`/api/tts?term=${encodeURIComponent("ice cream")}&lang=en-US`);
    audio.dispatch("ended");
    await p;
  });

  it("resolves speak() via timeout cap when nothing fires, and pauses audio so late playback cannot bleed into the next word", async () => {
    const { player, audio, timers } = makeEnv();
    const p = player.speak("cat");
    expect(timers.size()).toBe(1);
    expect(timers.msOf(1)).toBe(TTS_MAX_WAIT_MS);
    timers.fireAll();
    await p;
    expect(audio.paused).toBe(true);
  });

  it("clears the timeout once playback ends (no dangling timer)", async () => {
    const { player, audio, timers } = makeEnv();
    const p = player.speak("cat");
    audio.dispatch("ended");
    await p;
    expect(timers.size()).toBe(0);
  });

  // ---------- 打断：串词 bug 的根因 ----------
  it("interrupts the previous speak: old promise settles immediately, new src loads, no double sound", async () => {
    const { player, audio } = makeEnv();
    const first = player.speak("cat");
    const second = player.speak("dog");
    await first; // 旧朗读被打断后立即结束
    expect(audio.src).toContain("term=dog");
    audio.dispatch("ended");
    await second;
  });

  it("stop() settles a pending speak and pauses audio + cancels synthesis", async () => {
    const { player, audio, synth } = makeEnv();
    const p = player.speak("cat");
    player.stop();
    await p;
    expect(audio.paused).toBe(true);
    expect(synth!.cancelCalls).toBeGreaterThanOrEqual(1);
  });

  // ---------- 回退：合成失败不哑、不悬挂 ----------
  it("falls back to speechSynthesis when play() rejects, resolves on utterance end", async () => {
    const { player, audio, synth } = makeEnv({ audio: makeFakeAudio({ playResult: "reject" }) });
    const p = player.speak("cat");
    await new Promise((r) => setTimeout(r, 0)); // play() 拒绝经微任务传播后才回退
    expect(synth!.utterances.map((u) => u.text)).toEqual(["cat"]);
    expect(synth!.utterances[0].lang).toBe("en-US");
    synth!.utterances[0].onend!();
    await p;
  });

  it("falls back to speechSynthesis on audio error event (network fail mid-load)", async () => {
    const { player, audio, synth } = makeEnv();
    const p = player.speak("cat");
    audio.dispatch("error");
    expect(synth!.utterances.length).toBe(1);
    synth!.utterances[0].onend!();
    await p;
  });

  it("resolves immediately when play() rejects and no speechSynthesis exists", async () => {
    const { player } = makeEnv({
      audio: makeFakeAudio({ playResult: "reject" }),
      synth: null,
    });
    await player.speak("cat"); // 不悬挂
  });

  it("does not fall back twice when both play() rejects and error fires", async () => {
    const { player, audio, synth } = makeEnv({ audio: makeFakeAudio({ playResult: "reject" }) });
    const p = player.speak("cat");
    audio.dispatch("error"); // play() 已回退过，不应再建第二个 utterance
    expect(synth!.utterances.length).toBe(1);
    synth!.utterances[0].onend!();
    await p;
  });

  it("speak() resolves (not rejects) even when everything fails", async () => {
    const { player } = makeEnv({ synth: null, audio: makeFakeAudio({ playResult: "reject" }) });
    await expect(player.speak("cat")).resolves.toBeUndefined();
  });

  // ---------- BUG A：被打断的旧调用不得破坏新调用 ----------
  it("an interrupted speak's late play-rejection must not stop or fallback the newer speak", async () => {
    let rejectFirst!: (e: Error) => void;
    const audio = makeFakeAudio({ playResult: new Promise<void>((_, rej) => { rejectFirst = rej; }) });
    const { player, synth } = makeEnv({ audio });
    const first = player.speak("cat");
    const second = player.speak("dog"); // 打断第一个；此时第一个的 play() 仍悬挂
    rejectFirst(new Error("aborted load")); // 旧 play() 迟到拒绝
    await first;
    await new Promise((r) => setTimeout(r, 0)); // 拒绝经微任务传播到 catch
    expect(synth!.utterances.length).toBe(0); // 不应为新调用触发机械音回退
    expect(audio.paused).toBe(false);          // 不应暂停新调用的音频
    audio.dispatch("ended");
    await second;
  });

  it("a stale timeout from an interrupted speak must not stop the newer playback", async () => {
    const { player, audio, timers } = makeEnv();
    const first = player.speak("cat"); // timer id 1
    const second = player.speak("dog"); // timer id 2（打断第一个）
    timers.fire(1); // 旧调用的 4s 兜底超时迟到触发
    await first;
    expect(audio.paused).toBe(false); // 不得殃及新播放
    timers.fire(2);
    await second;
  });

  it("a stale utterance end must not settle the newer speak early", async () => {
    const { player, audio, synth } = makeEnv({ audio: makeFakeAudio({ playResult: "reject" }) });
    const first = player.speak("cat");
    await new Promise((r) => setTimeout(r, 0)); // cat 回退到机械音
    const second = player.speak("dog"); // 打断 cat（真实浏览器里 cancel 后 utterance 会补发 end）
    let settled = false;
    second.then(() => { settled = true; });
    synth!.utterances[0].onend!(); // cat 的 utterance 迟到结束
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false); // dog 不应被提前放行
    audio.dispatch("ended");
    await second;
    await first;
  });

  // ---------- prefetch：预热 HTTP 缓存 ----------
  describe("prefetch", () => {
    it("fetches each term's tts url once with concurrency bound, swallowing errors", async () => {
      const calls: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let active = 0;
      let maxActive = 0;
      const fetchImpl = async (url: string) => {
        calls.push(url);
        active++; maxActive = Math.max(maxActive, active);
        await gate;
        active--;
        if (url.includes("boom")) throw new Error("net");
        return { ok: true };
      };
      const { player } = makeEnv({ fetchImpl });
      const done = player.prefetch(["cat", "dog", "boom", "cat", "pig", "ox", "hen"]);
      await new Promise((r) => setTimeout(r, 0));
      expect(calls.length).toBe(3); // 并发上限 3，其余排队
      release();
      await done;
      expect(calls.length).toBe(6); // 去重后 6 个唯一词
      expect(maxActive).toBeLessThanOrEqual(3);
      expect(calls.every((u) => u.startsWith("/api/tts?term=") && u.endsWith("lang=en-US"))).toBe(true);
      expect(calls).toContain("/api/tts?term=boom&lang=en-US");
    });

    it("skips terms already prefetched by earlier calls", async () => {
      const calls: string[] = [];
      const fetchImpl = async (url: string) => { calls.push(url); return { ok: true }; };
      const { player } = makeEnv({ fetchImpl });
      await player.prefetch(["cat", "dog"]);
      await player.prefetch(["dog", "hen"]);
      expect(calls.sort()).toEqual(["/api/tts?term=cat&lang=en-US", "/api/tts?term=dog&lang=en-US", "/api/tts?term=hen&lang=en-US"]);
    });

    it("stores successful prefetches as blob urls and speak() plays them offline (no network url)", async () => {
      const fetchImpl = async () => ({ ok: true, blob: async () => "FAKEBLOB" });
      const { player, audio } = makeEnv({
        fetchImpl,
        createObjectURL: (b: unknown) => `blob:${b}`,
      });
      await player.prefetch(["cat"]);
      const p = player.speak("cat");
      expect(audio.src).toBe("blob:FAKEBLOB"); // 命中预取：不再走 /api/tts 网络
      audio.dispatch("ended");
      await p;
    });

    it("failed prefetch falls back to the network url at speak time", async () => {
      const fetchImpl = async () => ({ ok: false }); // 502 等失败
      const { player, audio } = makeEnv({
        fetchImpl,
        createObjectURL: (b: unknown) => `blob:${b}`,
      });
      await player.prefetch(["cat"]);
      const p = player.speak("cat");
      expect(audio.src).toBe("/api/tts?term=cat&lang=en-US");
      audio.dispatch("ended");
      await p;
    });
  });

  // ---------- unlock：进入学习时借手势解锁自动播放 ----------
  it("unlock() plays a short silent wav to earn autoplay permission", async () => {
    const { player, audio } = makeEnv();
    player.unlock();
    expect(audio.src.startsWith("data:audio/wav")).toBe(true);
    expect(audio.playCalls).toBe(1);
  });

  it("unlock() swallows rejection (unlocked too early is harmless)", () => {
    const { player } = makeEnv({ audio: makeFakeAudio({ playResult: "reject" }) });
    expect(() => player.unlock()).not.toThrow();
  });
});
