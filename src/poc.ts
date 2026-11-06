import { Hono } from "hono";
import type { Env } from "./index";

// POC:语音字母输入可行性验证(见 /poc 页面)。整体独立,验收后可连同
// public/poc.html / public/poc.js 与 index.ts 中的两行挂载一并删除。
const AZURE_STT_API_VERSION = "2025-10-15";
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const AZURE_TIMEOUT_MS = 15_000;

// 密钥回退:优先专用 STT 资源,缺省复用 TTS 资源(同一 Speech 资源开 STT 即可)。
export function pickSttCreds(env: {
  AZURE_TTS_KEY?: string;
  AZURE_TTS_REGION?: string;
  AZURE_STT_KEY?: string;
  AZURE_STT_REGION?: string;
}): { key: string; region: string } | null {
  if (env.AZURE_STT_KEY && env.AZURE_STT_REGION) {
    return { key: env.AZURE_STT_KEY, region: env.AZURE_STT_REGION };
  }
  if (env.AZURE_TTS_KEY && env.AZURE_TTS_REGION) {
    return { key: env.AZURE_TTS_KEY, region: env.AZURE_TTS_REGION };
  }
  return null;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

export function tokenizeText(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// W 的口语形态("double u" / "double you")折叠为单字母 w。
const W_SPOKEN = new Set(["doubleyou", "doubleu", "dubya"]);

// 从识别文本里抽取"听到的字母":优先独立单字母 token(忽略 "the letter b" 类填充),
// 其次识别 W 的整词口语形态,抽不出返回 null(交由前端按原文展示)。
export function extractHeardLetter(raw: string): string | null {
  const tokens = tokenizeText(raw);
  if (!tokens.length) return null;
  if (W_SPOKEN.has(tokens.join(""))) return "w";
  return tokens.find((t) => /^[a-z]$/.test(t)) ?? null;
}

export function constrainedLetterMatch(expected: string, raw: string): boolean {
  const exp = expected.trim().toLowerCase();
  if (!/^[a-z]$/.test(exp)) return false;
  return extractHeardLetter(raw) === exp;
}

// 单词模式:整词相等、包含目标 token 视为命中;长词(去空格 ≥5 字符)额外容忍
// 一处编辑距离的识别噪声。短词一处差异即真实混淆(如 cat/cap),不放宽。
export function constrainedWordMatch(expected: string, raw: string): boolean {
  const exp = expected.trim().toLowerCase();
  if (!exp || tokenizeText(exp).join(" ") !== exp) return false;
  const tokens = tokenizeText(raw);
  const norm = tokens.join(" ");
  if (norm === exp || tokens.includes(exp)) return true;
  if (exp.replace(/\s/g, "").length >= 5 && levenshtein(norm, exp) <= 1) return true;
  return false;
}

export function constrainedMatch(
  mode: "letter" | "word",
  expected: string,
  raw: string,
): boolean {
  return mode === "word"
    ? constrainedWordMatch(expected, raw)
    : constrainedLetterMatch(expected, raw);
}

// 供混淆矩阵展示用的归一化结果:字母模式返回大写单字母(或 null),单词模式返回词序列。
export function normalizeHeard(mode: "letter" | "word", raw: string): string | null {
  if (mode === "letter") {
    const letter = extractHeardLetter(raw);
    return letter ? letter.toUpperCase() : null;
  }
  const norm = tokenizeText(raw).join(" ");
  return norm || null;
}

export function extractAzureText(data: unknown): string {
  const d = data as {
    combinedPhrases?: Array<{ text?: string }>;
    phrases?: Array<{ text?: string }>;
  };
  const combined = d?.combinedPhrases?.[0]?.text;
  if (typeof combined === "string" && combined.trim()) return combined.trim();
  return (d?.phrases ?? [])
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .join(" ")
    .trim();
}

function audioExt(contentType: string): string {
  const base = contentType.split(";")[0].trim().toLowerCase();
  if (base === "audio/mp4") return "m4a";
  if (base === "audio/webm") return "webm";
  if (base === "audio/ogg") return "ogg";
  if (base === "audio/wav") return "wav";
  if (base === "audio/mpeg") return "mp3";
  if (base === "audio/flac") return "flac";
  return "bin";
}

// 转发 Azure Fast Transcription(同步 REST),可测:与 makeAzureProvider 同一模式。
// 成功返回识别文本;失败抛 `azure_<status>` / `azure_timeout` / `azure_bad_json`。
export async function transcribeAudio(opts: {
  key: string;
  region: string;
  bytes: ArrayBuffer;
  contentType: string;
}): Promise<string> {
  const fd = new FormData();
  fd.append(
    "audio",
    new File([opts.bytes], `audio.${audioExt(opts.contentType)}`, {
      type: opts.contentType.split(";")[0].trim(),
    }),
  );
  fd.append("definition", JSON.stringify({ locales: ["en-US"] }));

  let azureRes: Response;
  try {
    azureRes = await fetch(
      `https://${opts.region}.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=${AZURE_STT_API_VERSION}`,
      {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": opts.key,
          "User-Agent": "Mozilla/5.0 (compatible; dotVocab/1.0)",
        },
        body: fd,
        signal: AbortSignal.timeout(AZURE_TIMEOUT_MS),
      },
    );
  } catch (e) {
    throw new Error(
      e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")
        ? "azure_timeout"
        : "azure_network_error",
    );
  }
  if (!azureRes.ok) throw new Error(`azure_${azureRes.status}`);
  let data: unknown;
  try {
    data = await azureRes.json();
  } catch {
    throw new Error("azure_bad_json");
  }
  return extractAzureText(data);
}

// ---------- POC1:Cloudflare Workers AI whisper 对照 ----------

export type WhisperModel = "whisper-large-v3-turbo" | "whisper";

export function validateWhisperModel(raw: string | undefined): WhisperModel {
  return raw === "whisper" ? "whisper" : "whisper-large-v3-turbo";
}

// 字母表上下文提示:帮助模型把输出约束在字母/简单词空间,不泄漏目标答案
const ALPHABET_PROMPT =
  "The speaker says one letter of the English alphabet, or one short simple English word. " +
  "Letters: A B C D E F G H I J K L M N O P Q R S T U V W X Y Z.";

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// 经 Workers AI binding 调 whisper,可测:ai 参数注入 fake。
// 成功返回识别文本;失败抛 cf_error:*。
export async function whisperTranscribe(
  ai: Pick<Ai, "run">,
  bytes: Uint8Array,
  model: WhisperModel,
): Promise<string> {
  let out: unknown;
  if (model === "whisper") {
    out = await ai.run("@cf/openai/whisper", {
      audio: Array.from(bytes),
    });
  } else {
    out = await ai.run("@cf/openai/whisper-large-v3-turbo", {
      audio: toBase64(bytes),
      task: "transcribe",
      language: "en",
      initial_prompt: ALPHABET_PROMPT,
      condition_on_previous_text: false, // 防幻觉循环(纯音调时避免复读 initial_prompt)
    });
  }
  const text = (out as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text.trim() : "";
}

export const poc1 = new Hono<{ Bindings: Env }>();

poc1.get("/poc1", (c) =>
  c.env.ASSETS.fetch(new Request(new URL("/poc1.html", c.req.url), c.req.raw)),
);

poc1.post("/api/poc1/asr", async (c) => {
  const t0 = Date.now();
  const mode = c.req.query("mode") === "word" ? "word" : "letter";
  const expected = (c.req.query("expected") ?? "").trim().toLowerCase().slice(0, 40);
  const model = validateWhisperModel(c.req.query("model"));
  const contentType = (c.req.header("Content-Type") ?? "").trim();
  const body = await c.req.arrayBuffer();
  // 前端已统一转 16kHz 单声道 WAV,但仍按 audio/* 校验透传,避免写死
  if (!/^audio\/[a-z0-9.+-]+/i.test(contentType)) {
    return c.json({ error: "bad_content_type" }, 400);
  }
  if (!body.byteLength) return c.json({ error: "empty_body" }, 400);
  if (body.byteLength > MAX_AUDIO_BYTES) return c.json({ error: "too_large" }, 413);

  if (!c.env.AI || typeof c.env.AI.run !== "function") {
    return c.json({ error: "cf_not_configured" }, 500);
  }

  const t1 = Date.now();
  let text: string;
  try {
    text = await whisperTranscribe(c.env.AI, new Uint8Array(body), model);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: `cf_error:${msg.slice(0, 120)}` }, 502);
  }
  const msModel = Date.now() - t1;

  return c.json({
    text,
    normalized: normalizeHeard(mode, text),
    match: constrainedMatch(mode, expected, text),
    model,
    ms_model: msModel,
    ms_total: Date.now() - t0,
  });
});

export const poc = new Hono<{ Bindings: Env }>();

// 裸路径 /poc 若走 ASSETS 兜底会被 SPA not_found 吃成首页,这里显式改写到 /poc.html。
poc.get("/poc", (c) =>
  c.env.ASSETS.fetch(new Request(new URL("/poc.html", c.req.url), c.req.raw)),
);

poc.post("/api/poc/asr", async (c) => {
  const t0 = Date.now();
  const mode = c.req.query("mode") === "word" ? "word" : "letter";
  const expected = (c.req.query("expected") ?? "").trim().toLowerCase().slice(0, 40);
  const contentType = (c.req.header("Content-Type") ?? "").trim();
  const body = await c.req.arrayBuffer();
  // 录音格式由客户端 MediaRecorder 决定(iOS mp4 / Chrome webm),必须原样透传。
  if (!/^audio\/[a-z0-9.+-]+/i.test(contentType)) {
    return c.json({ error: "bad_content_type" }, 400);
  }
  if (!body.byteLength) return c.json({ error: "empty_body" }, 400);
  if (body.byteLength > MAX_AUDIO_BYTES) return c.json({ error: "too_large" }, 413);

  const creds = pickSttCreds(c.env);
  if (!creds) return c.json({ error: "stt_not_configured" }, 500);

  const t1 = Date.now();
  let text: string;
  try {
    text = await transcribeAudio({ ...creds, bytes: body, contentType });
  } catch (e) {
    const code = e instanceof Error ? e.message : "azure_unknown";
    const status = code === "azure_timeout" ? 504 : 502;
    return c.json({ error: code }, status);
  }
  const msWorkerToAzure = Date.now() - t1;

  return c.json({
    text,
    normalized: normalizeHeard(mode, text),
    match: constrainedMatch(mode, expected, text),
    ms_worker_to_azure: msWorkerToAzure,
    ms_total: Date.now() - t0,
  });
});
