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
      return opts.playResult === "reject"
        ? Promise.reject(new Error("not allowed"))
        : Promise.resolve();
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
