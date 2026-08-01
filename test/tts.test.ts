import { describe, it, expect, vi } from "vitest";
import { validateTerm, cacheKey, escapeXml, makeAzureProvider, AZURE_PROVIDER_NAME } from "../src/tts";

describe("validateTerm", () => {
  it("returns null for missing / empty / whitespace", () => {
    expect(validateTerm(undefined)).toBeNull();
    expect(validateTerm("")).toBeNull();
    expect(validateTerm("   ")).toBeNull();
  });
  it("returns null when > 200 chars", () => {
    expect(validateTerm("a".repeat(201))).toBeNull();
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
    // voice is fixed JennyNeural; ampersand in text is XML-escaped
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
