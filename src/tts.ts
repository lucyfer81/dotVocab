import { Hono } from "hono";
import type { Env } from "./index";
import { isValidTerm } from "./term";

const XML_ENTITIES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
};

export function validateTerm(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  if (!isValidTerm(t)) return null;
  return t.toLowerCase();
}

export function validateLang(raw: string | undefined): string | null {
  const lang = raw && raw.trim().length > 0 ? raw : "en-US";
  if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,4})?$/.test(lang)) return null;
  return lang;
}

export function cacheKey(lang: string, providerName: string, term: string): string {
  return `audio:${lang}:${providerName}:${term}`;
}

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => XML_ENTITIES[ch]);
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
          "User-Agent": "Mozilla/5.0 (compatible; dotVocab/1.0)",
          "Accept": "*/*",
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
  let bytes: ArrayBuffer;
  try {
    bytes = await opts.provider.synthesize(opts.term, opts.lang);
  } catch {
    return null;
  }
  try {
    await opts.kv.put(key, bytes);
  } catch {
    // non-fatal: serve the synthesized audio even if the cache write fails
  }
  return bytes;
}

export const tts = new Hono<{ Bindings: Env }>();

tts.get("/tts", async (c) => {
  const term = validateTerm(c.req.query("term"));
  if (!term) return c.json({ error: "bad_term" }, 400);
  const lang = validateLang(c.req.query("lang"));
  if (!lang) return c.json({ error: "bad_lang" }, 400);
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
