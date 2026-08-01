import { Hono } from "hono";
import type { Env } from "./index";

export function validateTerm(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  if (t.length > 200) return null;
  if (!/^[A-Za-z0-9 \-'.?,!]+$/.test(t)) return null;
  return t.toLowerCase();
}

export function cacheKey(lang: string, providerName: string, term: string): string {
  return `audio:${lang}:${providerName}:${term}`;
}

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[ch] as string));
}

export interface TtsProvider {
  name: string;
  synthesize(text: string, lang: string): Promise<ArrayBuffer>;
}

export const AZURE_PROVIDER_NAME = "azure-jenny";

export function makeAzureProvider(env: {
  AZURE_TTS_KEY: string;
  AZURE_TTS_REGION: string;
}): TtsProvider {
  return {
    name: AZURE_PROVIDER_NAME,
    async synthesize(text, lang) {
      if (!env.AZURE_TTS_KEY || !env.AZURE_TTS_REGION) {
        throw new Error("azure_not_configured");
      }
      const url = `https://${env.AZURE_TTS_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;
      const ssml =
        `<speak version='1.0' xml:lang='${escapeXml(lang)}'` +
        ` xmlns='http://www.w3.org/2001/10/synthesis'>` +
        `<voice name='en-US-JennyNeural'>${escapeXml(text)}</voice></speak>`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": env.AZURE_TTS_KEY,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "audio-48khz-192kbitrate-mono-mp3",
        },
        body: ssml,
      });
      if (!res.ok) throw new Error(`azure_${res.status}`);
      return await res.arrayBuffer();
    },
  };
}

export async function synthesizeWithCache(opts: {
  kv: KVNamespace;
  lang: string;
  term: string;
  provider: TtsProvider;
}): Promise<ArrayBuffer | null> {
  const key = cacheKey(opts.lang, opts.provider.name, opts.term);
  const cached = await opts.kv.get(key, "arrayBuffer");
  if (cached) return cached;
  try {
    const bytes = await opts.provider.synthesize(opts.term, opts.lang);
    await opts.kv.put(key, bytes);
    return bytes;
  } catch {
    return null;
  }
}

export const tts = new Hono<{ Bindings: Env }>();

tts.get("/tts", async (c) => {
  const term = validateTerm(c.req.query("term"));
  if (!term) return c.json({ error: "bad_term" }, 400);
  const lang = c.req.query("lang") || "en-US";
  const provider = makeAzureProvider(c.env);
  const bytes = await synthesizeWithCache({ kv: c.env.AUDIO, lang, term, provider });
  if (!bytes) return c.json({ error: "synthesis_failed" }, 502);
  return new Response(bytes, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});
