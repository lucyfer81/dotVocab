import { describe, it, expect, vi } from "vitest";
import { SELF } from "cloudflare:test";
import {
  pickSttCreds,
  levenshtein,
  tokenizeText,
  extractHeardLetter,
  constrainedLetterMatch,
  constrainedWordMatch,
  constrainedMatch,
  normalizeHeard,
  extractAzureText,
  transcribeAudio,
  validateWhisperModel,
  whisperTranscribe,
} from "../src/poc";

describe("pickSttCreds", () => {
  it("prefers dedicated STT credentials when both present", () => {
    expect(
      pickSttCreds({
        AZURE_TTS_KEY: "tts-k",
        AZURE_TTS_REGION: "tts-r",
        AZURE_STT_KEY: "stt-k",
        AZURE_STT_REGION: "stt-r",
      }),
    ).toEqual({ key: "stt-k", region: "stt-r" });
  });

  it("falls back to TTS credentials", () => {
    expect(pickSttCreds({ AZURE_TTS_KEY: "tts-k", AZURE_TTS_REGION: "tts-r" })).toEqual({
      key: "tts-k",
      region: "tts-r",
    });
  });

  it("returns null when neither pair is complete", () => {
    expect(pickSttCreds({})).toBeNull();
    expect(pickSttCreds({ AZURE_STT_KEY: "k" })).toBeNull();
    expect(pickSttCreds({ AZURE_TTS_KEY: "k", AZURE_TTS_REGION: "" })).toBeNull();
  });
});

describe("levenshtein", () => {
  it("returns 0 for equal strings", () => {
    expect(levenshtein("abc", "abc")).toBe(0);
  });
  it("computes substitution/insert/deletion distances", () => {
    expect(levenshtein("cat", "cap")).toBe(1);
    expect(levenshtein("cat", "cart")).toBe(1);
    expect(levenshtein("cat", "ca")).toBe(1);
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });
});

describe("tokenizeText", () => {
  it("lowercases, strips punctuation, and collapses whitespace", () => {
    expect(tokenizeText("  The letter, B.  ")).toEqual(["the", "letter", "b"]);
    expect(tokenizeText("...")).toEqual([]);
  });
});

describe("extractHeardLetter", () => {
  it("returns the standalone single-letter token", () => {
    expect(extractHeardLetter("B.")).toBe("b");
    expect(extractHeardLetter("the letter b")).toBe("b");
    expect(extractHeardLetter("A b c")).toBe("a");
  });
  it("folds spoken forms of W", () => {
    expect(extractHeardLetter("double you")).toBe("w");
    expect(extractHeardLetter("double u")).toBe("w");
  });
  it("returns null when no letter-like token exists", () => {
    expect(extractHeardLetter("")).toBeNull();
    expect(extractHeardLetter("hello")).toBeNull();
  });
});

describe("constrainedLetterMatch", () => {
  it("matches despite case, punctuation, and filler words", () => {
    expect(constrainedLetterMatch("B", "B.")).toBe(true);
    expect(constrainedLetterMatch("b", "The letter B")).toBe(true);
    expect(constrainedLetterMatch("w", "double you")).toBe(true);
  });
  it("does not match a different letter (B/D confusion)", () => {
    expect(constrainedLetterMatch("b", "d")).toBe(false);
    expect(constrainedLetterMatch("b", "the letter D.")).toBe(false);
  });
  it("rejects invalid expected values", () => {
    expect(constrainedLetterMatch("", "b")).toBe(false);
    expect(constrainedLetterMatch("bd", "b")).toBe(false);
  });
});

describe("constrainedWordMatch", () => {
  it("matches on normalized equality or containment", () => {
    expect(constrainedWordMatch("cat", "Cat.")).toBe(true);
    expect(constrainedWordMatch("cat", "a cat")).toBe(true);
  });
  it("does not relax short words by edit distance (cat/cap is a real miss)", () => {
    expect(constrainedWordMatch("cat", "cap")).toBe(false);
    expect(constrainedWordMatch("cat", "catt")).toBe(false);
  });
  it("tolerates one edit for longer words", () => {
    expect(constrainedWordMatch("elephant", "elephent")).toBe(true);
    expect(constrainedWordMatch("elephant", "elephants")).toBe(true);
    expect(constrainedWordMatch("elephant", "elegant")).toBe(false);
  });
});

describe("constrainedMatch / normalizeHeard dispatch", () => {
  it("dispatches by mode", () => {
    expect(constrainedMatch("letter", "b", "B.")).toBe(true);
    expect(constrainedMatch("word", "cat", "Cat.")).toBe(true);
  });
  it("normalizes letter mode to an uppercase letter or null", () => {
    expect(normalizeHeard("letter", "the letter b")).toBe("B");
    expect(normalizeHeard("letter", "hello")).toBeNull();
  });
  it("normalizes word mode to a token sequence", () => {
    expect(normalizeHeard("word", "Hello, world!")).toBe("hello world");
    expect(normalizeHeard("word", "?!")).toBeNull();
  });
});

describe("extractAzureText", () => {
  it("prefers combinedPhrases text", () => {
    expect(
      extractAzureText({
        phrases: [{ text: "b" }],
        combinedPhrases: [{ text: " B. " }],
      }),
    ).toBe("B.");
  });
  it("joins phrase texts when combinedPhrases is absent or empty", () => {
    expect(extractAzureText({ phrases: [{ text: "a" }, { text: "b" }] })).toBe("a b");
    expect(extractAzureText({ phrases: [] })).toBe("");
    expect(extractAzureText({})).toBe("");
  });
});

describe("transcribeAudio", () => {
  it("POSTs multipart to the regional Fast Transcription endpoint and returns the text", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ phrases: [{ text: "b" }], combinedPhrases: [{ text: " B. " }] }),
        { status: 200 },
      ) as any,
    );
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const out = await transcribeAudio({
      key: "SECRET",
      region: "eastasia",
      bytes,
      contentType: "audio/mp4",
    });

    expect(out).toBe("B.");
    expect(spy).toHaveBeenCalledOnce();
    const [url, init]: any = spy.mock.calls[0];
    expect(url).toBe(
      "https://eastasia.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15",
    );
    expect(init.method).toBe("POST");
    expect(init.headers["Ocp-Apim-Subscription-Key"]).toBe("SECRET");
    const fd = init.body as FormData;
    expect(fd.get("definition")).toBe(JSON.stringify({ locales: ["en-US"] }));
    const audio = fd.get("audio") as unknown as File;
    expect(audio.name).toBe("audio.m4a"); // iOS mp4 → m4a 扩展名
    expect(audio.type).toBe("audio/mp4");
    expect((await audio.arrayBuffer()).byteLength).toBe(3);
    spy.mockRestore();
  });

  it("keeps the full mimeType suffix out of the forwarded File type", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ phrases: [] }), { status: 200 }) as any,
    );
    await transcribeAudio({
      key: "k",
      region: "r",
      bytes: new Uint8Array([0]).buffer,
      contentType: "audio/webm;codecs=opus",
    });
    const [, init]: any = spy.mock.calls[0];
    const audio = (init.body as FormData).get("audio") as unknown as File;
    expect(audio.type).toBe("audio/webm");
    expect(audio.name).toBe("audio.webm");
    spy.mockRestore();
  });

  it("throws azure_<status> on a non-2xx upstream response", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 400 }) as any,
    );
    await expect(
      transcribeAudio({
        key: "k",
        region: "r",
        bytes: new Uint8Array([0]).buffer,
        contentType: "audio/wav",
      }),
    ).rejects.toThrow(/azure_400/);
    spy.mockRestore();
  });
});

describe("whisperTranscribe", () => {
  function fakeAi(out: unknown, impl?: (model: string, input: any) => Promise<unknown>) {
    return {
      run: vi.fn(impl ?? (async () => out)),
    };
  }

  it("turbo: sends base64 audio with language + alphabet initial_prompt, returns trimmed text", async () => {
    const ai = fakeAi({ text: " B. " });
    const bytes = new Uint8Array([1, 2, 3, 250, 0]);
    const out = await whisperTranscribe(ai as any, bytes, "whisper-large-v3-turbo");

    expect(out).toBe("B.");
    expect(ai.run).toHaveBeenCalledOnce();
    const [model, input]: any = ai.run.mock.calls[0];
    expect(model).toBe("@cf/openai/whisper-large-v3-turbo");
    expect(input.task).toBe("transcribe");
    expect(input.language).toBe("en");
    expect(input.initial_prompt).toContain("A B C");
    // base64 应能无损还原音频字节
    const decoded = Uint8Array.from(atob(input.audio), (ch) => ch.charCodeAt(0));
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  it("base: sends audio as a plain number array", async () => {
    const ai = fakeAi({ text: "hello" });
    const bytes = new Uint8Array([7, 8, 9]);
    const out = await whisperTranscribe(ai as any, bytes, "whisper");

    expect(out).toBe("hello");
    const [model, input]: any = ai.run.mock.calls[0];
    expect(model).toBe("@cf/openai/whisper");
    expect(input.audio).toEqual([7, 8, 9]);
  });

  it("returns empty string for missing/non-string text", async () => {
    const ai = fakeAi({ word_count: 3 });
    expect(await whisperTranscribe(ai as any, new Uint8Array([1]), "whisper")).toBe("");
    const ai2 = fakeAi(null);
    expect(await whisperTranscribe(ai2 as any, new Uint8Array([1]), "whisper")).toBe("");
  });

  it("propagates AI binding errors", async () => {
    const ai = fakeAi({}, async () => {
      throw new Error("model not found");
    });
    await expect(
      whisperTranscribe(ai as any, new Uint8Array([1]), "whisper"),
    ).rejects.toThrow(/model not found/);
  });
});

describe("validateWhisperModel", () => {
  it("defaults to large-v3-turbo and whitelists base whisper", () => {
    expect(validateWhisperModel(undefined)).toBe("whisper-large-v3-turbo");
    expect(validateWhisperModel("whisper")).toBe("whisper");
    expect(validateWhisperModel("whisper-large-v3-turbo")).toBe("whisper-large-v3-turbo");
    expect(validateWhisperModel("gpt-4")).toBe("whisper-large-v3-turbo");
  });
});

describe("POC routes", () => {
  it("GET /poc serves the experiment page (not the SPA index)", async () => {
    const res = await SELF.fetch("https://example.com/poc");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("POC");
    expect(body).toContain("poc.js");
  });

  it("POST /api/poc/asr rejects a missing or non-audio Content-Type", async () => {
    const noType = await SELF.fetch("https://example.com/api/poc/asr", {
      method: "POST",
      body: "x",
    });
    expect(noType.status).toBe(400);
    expect(await noType.json()).toEqual({ error: "bad_content_type" });

    const jsonType = await SELF.fetch("https://example.com/api/poc/asr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(jsonType.status).toBe(400);
    expect(await jsonType.json()).toEqual({ error: "bad_content_type" });
  });

  it("POST /api/poc/asr rejects an empty audio body", async () => {
    const res = await SELF.fetch("https://example.com/api/poc/asr", {
      method: "POST",
      headers: { "Content-Type": "audio/webm;codecs=opus" },
      body: new Uint8Array(0),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "empty_body" });
  });

  it("POST /api/poc/asr reports missing STT credentials explicitly", async () => {
    const res = await SELF.fetch("https://example.com/api/poc/asr", {
      method: "POST",
      headers: { "Content-Type": "audio/mp4" },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "stt_not_configured" });
  });

  it("GET /poc1 serves the Cloudflare experiment page", async () => {
    const res = await SELF.fetch("https://example.com/poc1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Cloudflare Workers AI");
    expect(body).toContain("poc1.js");
  });

  it("POST /api/poc1/asr rejects a missing or non-audio Content-Type", async () => {
    const noType = await SELF.fetch("https://example.com/api/poc1/asr", {
      method: "POST",
      body: "x",
    });
    expect(noType.status).toBe(400);
    expect(await noType.json()).toEqual({ error: "bad_content_type" });
  });

  it("POST /api/poc1/asr rejects an empty audio body", async () => {
    const res = await SELF.fetch("https://example.com/api/poc1/asr?model=whisper", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: new Uint8Array(0),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "empty_body" });
  });

  it("POST /api/poc1/asr reports missing AI binding explicitly (test config has no [ai])", async () => {
    const res = await SELF.fetch("https://example.com/api/poc1/asr", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "cf_not_configured" });
  });
});
