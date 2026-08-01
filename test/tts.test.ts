import { describe, it, expect, vi } from "vitest";
import { SELF, env } from "cloudflare:test";
import { validateTerm, validateLang, cacheKey, escapeXml, makeAzureProvider, AZURE_PROVIDER_NAME, synthesizeWithCache, type TtsProvider } from "../src/tts";

describe("validateTerm", () => {
  it("returns null for missing / empty / whitespace", () => {
    expect(validateTerm(undefined)).toBeNull();
    expect(validateTerm("")).toBeNull();
    expect(validateTerm("   ")).toBeNull();
  });
  it("returns null when > 200 chars", () => {
    expect(validateTerm("a".repeat(201))).toBeNull();
  });
  it("allows exactly 200 characters (boundary)", () => {
    expect(validateTerm("a".repeat(200))).toBe("a".repeat(200));
  });
  it("returns null for disallowed characters", () => {
    expect(validateTerm("hello<world")).toBeNull();
    expect(validateTerm("a;b")).toBeNull();
    expect(validateTerm("你好")).toBeNull();
  });
  it("normalizes (trim + lowercase) allowed input", () => {
    expect(validateTerm("  Hello  ")).toBe("hello");
    expect(validateTerm("Fish-and-Chips")).toBe("fish-and-chips");
    expect(validateTerm("it's")).toBe("it's");
    expect(validateTerm("What?")).toBe("what?");
  });
});

describe("validateLang", () => {
  it("defaults to en-US when absent", () => {
    expect(validateLang(undefined)).toBe("en-US");
  });
  it("accepts standard region tags", () => {
    expect(validateLang("en-GB")).toBe("en-GB");
    expect(validateLang("zh-CN")).toBe("zh-CN");
  });
  it("accepts a bare 2-letter language", () => {
    expect(validateLang("en")).toBe("en");
  });
  it("rejects invalid tags", () => {
    expect(validateLang("english")).toBeNull();
    expect(validateLang("en:US")).toBeNull();
    expect(validateLang("en-US-extra")).toBeNull();
  });
});

describe("cacheKey", () => {
  it("joins lang, provider name, and term with the audio: prefix", () => {
    expect(cacheKey("en-US", "azure-jenny", "hello")).toBe("audio:en-US:azure-jenny:hello");
  });
});

describe("escapeXml", () => {
  it("escapes the five XML special characters", () => {
    expect(escapeXml("a & b < c > d \" e ' f"))
      .toBe("a &amp; b &lt; c &gt; d &quot; e &apos; f");
  });
  it("leaves other text untouched", () => {
    expect(escapeXml("hello world")).toBe("hello world");
  });
  it("returns empty string unchanged", () => {
    expect(escapeXml("")).toBe("");
  });
});

describe("AzureTtsProvider", () => {
  it("name is the azure-jenny constant", () => {
    const p = makeAzureProvider({ AZURE_TTS_KEY: "k", AZURE_TTS_REGION: "eastasia" });
    expect(p.name).toBe(AZURE_PROVIDER_NAME);
    expect(p.name).toBe("azure-jenny");
  });

  it("throws without making a network call when key/region missing", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const p = makeAzureProvider({ AZURE_TTS_KEY: "", AZURE_TTS_REGION: "eastasia" });
    await expect(p.synthesize("hi", "en-US")).rejects.toThrow(/azure_not_configured/);
    const p2 = makeAzureProvider({ AZURE_TTS_KEY: "k", AZURE_TTS_REGION: "" });
    await expect(p2.synthesize("hi", "en-US")).rejects.toThrow(/azure_not_configured/);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("POSTs to the region endpoint with correct headers + SSML and returns bytes", async () => {
    const fakeBytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(fakeBytes, { status: 200 }) as any
    );
    const p = makeAzureProvider({ AZURE_TTS_KEY: "SECRET", AZURE_TTS_REGION: "eastasia" });
    const out = await p.synthesize("hello & hi", "en-US");

    expect(out.byteLength).toBe(4);
    expect(spy).toHaveBeenCalledOnce();
    const [url, init]: any = spy.mock.calls[0];
    expect(url).toBe("https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1");
    expect(init.method).toBe("POST");
    expect(init.headers["Ocp-Apim-Subscription-Key"]).toBe("SECRET");
    expect(init.headers["Content-Type"]).toBe("application/ssml+xml");
    expect(init.headers["X-Microsoft-OutputFormat"]).toBe("audio-48khz-192kbitrate-mono-mp3");
    expect(init.body).toContain("en-US-JennyNeural");
    expect(init.body).toContain("hello &amp; hi");
    spy.mockRestore();
  });

  it("throws on non-2xx Azure response", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("upstream error", { status: 401 }) as any
    );
    const p = makeAzureProvider({ AZURE_TTS_KEY: "k", AZURE_TTS_REGION: "eastasia" });
    await expect(p.synthesize("hi", "en-US")).rejects.toThrow(/azure_401/);
    spy.mockRestore();
  });
});

function fakeKv(initial: Record<string, ArrayBuffer> = {}, opts: { putThrows?: boolean } = {}) {
  const store = new Map<string, ArrayBuffer>(Object.entries(initial));
  return {
    store,
    kv: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, val: ArrayBuffer) => {
        if (opts.putThrows) throw new Error("kv_put_failed");
        store.set(key, val);
      },
    } as unknown as KVNamespace,
  };
}

function fakeProvider(synthesize: TtsProvider["synthesize"]): TtsProvider {
  return { name: AZURE_PROVIDER_NAME, synthesize };
}

describe("synthesizeWithCache", () => {
  it("returns cached bytes and does NOT call the provider on a hit", async () => {
    const term = "hello";
    const key = cacheKey("en-US", AZURE_PROVIDER_NAME, term);
    const cached = new Uint8Array([9, 9]).buffer;
    const { kv } = fakeKv({ [key]: cached });
    const syn: TtsProvider["synthesize"] = vi.fn();
    const out = await synthesizeWithCache({ kv, lang: "en-US", term, provider: fakeProvider(syn) });
    expect(out).toBe(cached);
    expect(syn).not.toHaveBeenCalled();
  });

  it("on a miss, calls the provider, writes KV, and returns the bytes", async () => {
    const term = "world";
    const key = cacheKey("en-US", AZURE_PROVIDER_NAME, term);
    const { kv, store } = fakeKv();
    const fresh = new Uint8Array([7, 7, 7]).buffer;
    const syn: TtsProvider["synthesize"] = vi.fn(async () => fresh);
    const out = await synthesizeWithCache({ kv, lang: "en-US", term, provider: fakeProvider(syn) });
    expect(out).toBe(fresh);
    expect(syn).toHaveBeenCalledWith("world", "en-US");
    expect(store.get(key)).toBe(fresh);
  });

  it("returns null (and does not write KV) when the provider throws", async () => {
    const term = "boom";
    const { kv, store } = fakeKv();
    const syn: TtsProvider["synthesize"] = vi.fn(async () => { throw new Error("azure_500"); });
    const out = await synthesizeWithCache({ kv, lang: "en-US", term, provider: fakeProvider(syn) });
    expect(out).toBeNull();
    expect(store.size).toBe(0);
  });

  it("still returns synthesized bytes when KV put throws (non-fatal)", async () => {
    const term = "hello";
    const { kv } = fakeKv({}, { putThrows: true });
    const fresh = new Uint8Array([7, 7, 7]).buffer;
    const syn: TtsProvider["synthesize"] = vi.fn(async () => fresh);
    const out = await synthesizeWithCache({ kv, lang: "en-US", term, provider: fakeProvider(syn) });
    expect(out).toBe(fresh);
    expect(syn).toHaveBeenCalledOnce();
  });
});

describe("GET /api/tts (route)", () => {
  it("returns 400 for a missing term", async () => {
    const res = await SELF.fetch("https://example.com/api/tts");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_term" });
  });

  it("returns 400 for an invalid term", async () => {
    const res = await SELF.fetch("https://example.com/api/tts?term=bad<word");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_term" });
  });

  it("returns 400 for an invalid lang", async () => {
    const res = await SELF.fetch("https://example.com/api/tts?term=apple&lang=en:US");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_lang" });
  });

  it("returns cached mp3 with correct headers on a cache hit", async () => {
    const term = "apple";
    const key = cacheKey("en-US", AZURE_PROVIDER_NAME, term);
    const bytes = new Uint8Array([0x49, 0x44, 0x33, 0x04]).buffer;
    await env.AUDIO.put(key, bytes);

    const res = await SELF.fetch("https://example.com/api/tts?term=apple");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const out = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(out)).toEqual([0x49, 0x44, 0x33, 0x04]);
  });
});
