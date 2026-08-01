# Pronunciation Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the browser `speechSynthesis` robot voice with Azure Neural TTS (`en-US-JennyNeural`) audio served via a new `GET /api/tts` endpoint, cached in Cloudflare KV, with the old mechanism kept as a frontend fallback.

**Architecture:** A new `src/tts.ts` Hono sub-router exposes `GET /api/tts?term=&lang=en-US`. It validates the term, looks up an mp3 in the `AUDIO` KV namespace (key `audio:{lang}:{providerName}:{normalizedTerm}`, no TTL), and on miss calls an injectable `TtsProvider` (AzureTtsProvider → REST POST returning mp3), writing the result back to KV. The frontend `speak()` in `public/app.js` plays `/api/tts` via an `<audio>` element and falls back to `speechSynthesis` on any failure.

**Tech Stack:** Cloudflare Workers + Hono (TypeScript, strict), Cloudflare KV, Azure Cognitive Services TTS REST API, vitest + `@cloudflare/vitest-pool-workers` (tests go through `SELF.fetch` against the real worker in miniflare; pure units are direct-imported with `vi` mocks).

## Global Constraints

(From the spec `docs/superpowers/specs/2026-08-01-pronunciation-upgrade-design.md`; every task implicitly inherits these.)

- **No new npm dependencies.** Azure TTS is a standard `fetch` POST; do not add any package.
- **Voice is fixed** to `en-US-JennyNeural`; export the constant `AZURE_PROVIDER_NAME = "azure-jenny"` and use it in both the provider and the cache key.
- **Cache key format** `audio:{lang}:{providerName}:{normalizedTerm}` where `normalizedTerm = term.trim().toLowerCase()`. **No `expirationTtl`** on KV puts.
- **Term validation:** after trim, non-empty, length ≤ 200, and matches `/^[A-Za-z0-9 \-'.?,!]+$/`; otherwise HTTP 400.
- **Default `lang`** is `en-US` (used when query param absent).
- **Response contract:** success → `200`, `Content-Type: audio/mpeg`, `Cache-Control: public, max-age=31536000, immutable`; synthesis failure → `502 {error:"synthesis_failed"}`; bad term → `400 {error:"bad_term"}`.
- **Azure credentials** come from Worker secrets `AZURE_TTS_KEY` and `AZURE_TTS_REGION` (via `Env`), never committed. If either is empty, the provider throws `azure_not_configured` **without** making a network call.
- **Frontend fallback:** `speak()` must keep calling `speechSynthesis` if `<audio>` playback fails; existing call sites (`public/app.js:116`, `:135`, `:141`) stay unchanged.
- **Verification gate:** there is no `lint`/`typecheck` npm script; run `npm test` (vitest). TypeScript is `strict`, `target ES2022`, `module ESNext`.
- **Commit style:** lowercase conventional prefixes with Chinese descriptions, e.g. `feat(tts): ...`, `test(tts): ...`.

## File Structure

- **`src/tts.ts`** (NEW) — all TTS logic: pure helpers (`validateTerm`, `cacheKey`, `escapeXml`), `TtsProvider` interface, `AZURE_PROVIDER_NAME`, `makeAzureProvider`, `synthesizeWithCache`, and the `tts` Hono sub-router with the `GET /tts` handler. Single focused module; all units testable in isolation.
- **`src/index.ts`** (MODIFY) — extend `Env` with `AUDIO: KVNamespace`, `AZURE_TTS_KEY: string`, `AZURE_TTS_REGION: string`; mount `app.route("/api", tts)`.
- **`wrangler.toml`** (MODIFY) — add `[[kv_namespaces]]` binding `AUDIO`.
- **`public/app.js`** (MODIFY) — rewrite `speak()` (lines 24-30).
- **`.dev.vars`** (MODIFY, gitignored) — add `AZURE_TTS_KEY` / `AZURE_TTS_REGION` for local dev.
- **`test/tts.test.ts`** (NEW) — unit tests for helpers/provider/orchestration + `SELF.fetch` route tests.

---

### Task 1: Pure helpers (`validateTerm`, `cacheKey`, `escapeXml`)

**Files:**
- Create: `src/tts.ts`
- Create: `test/tts.test.ts`

**Interfaces:**
- Produces (exported from `src/tts.ts`):
  - `export function validateTerm(raw: string | undefined): string | null` — returns normalized (`trim().toLowerCase()`) term if valid, else `null`.
  - `export function cacheKey(lang: string, providerName: string, term: string): string` — returns `audio:{lang}:{providerName}:{term}` (term assumed already normalized).
  - `export function escapeXml(s: string): string` — escapes `& < > " '`.

- [ ] **Step 1: Write the failing tests**

Create `test/tts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateTerm, cacheKey, escapeXml } from "../src/tts";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/tts.test.ts`
Expected: FAIL — modules `../src/tts` exports nothing / file not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/tts.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/tts.test.ts`
Expected: PASS (all three describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add src/tts.ts test/tts.test.ts
git commit -m "feat(tts): 纯函数 validateTerm/cacheKey/escapeXml"
```

---

### Task 2: AzureTtsProvider (`makeAzureProvider`)

**Files:**
- Modify: `src/tts.ts` (append interface + provider)
- Modify: `test/tts.test.ts` (append tests)

**Interfaces:**
- Produces (exported from `src/tts.ts`):
  - `export interface TtsProvider { name: string; synthesize(text: string, lang: string): Promise<ArrayBuffer>; }`
  - `export const AZURE_PROVIDER_NAME = "azure-jenny";`
  - `export function makeAzureProvider(env: { AZURE_TTS_KEY: string; AZURE_TTS_REGION: string }): TtsProvider`

- [ ] **Step 1: Write the failing tests**

Append to `test/tts.test.ts` (add `vi` to the vitest import at the top of the file: `import { describe, it, expect, vi } from "vitest";`):

```ts
import { makeAzureProvider, AZURE_PROVIDER_NAME } from "../src/tts";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/tts.test.ts`
Expected: FAIL — `makeAzureProvider` / `AZURE_PROVIDER_NAME` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/tts.ts`:

```ts
export interface TtsProvider {
  /** Version segment embedded in the cache key (change it when swapping voice/engine). */
  name: string;
  /** Synthesize text into mp3 bytes. Throws on any failure. */
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/tts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tts.ts test/tts.test.ts
git commit -m "feat(tts): AzureTtsProvider via Azure REST + 注入 env"
```

---

### Task 3: `synthesizeWithCache` orchestration

**Files:**
- Modify: `src/tts.ts` (append orchestration)
- Modify: `test/tts.test.ts` (append tests)

**Interfaces:**
- Consumes: `cacheKey`, `TtsProvider` (from Tasks 1–2), and a `KVNamespace`.
- Produces (exported from `src/tts.ts`):
  - `export async function synthesizeWithCache(opts: { kv: KVNamespace; lang: string; term: string; provider: TtsProvider; }): Promise<ArrayBuffer | null>` — returns cached bytes on hit (skipping the provider); on miss calls provider, writes KV, returns bytes; returns `null` if the provider throws (never rethrows).

- [ ] **Step 1: Write the failing tests**

Append to `test/tts.test.ts`:

```ts
import { synthesizeWithCache, cacheKey, AZURE_PROVIDER_NAME, type TtsProvider } from "../src/tts";

function fakeKv(initial: Record<string, ArrayBuffer> = {}) {
  const store = new Map<string, ArrayBuffer>(Object.entries(initial));
  return {
    store,
    kv: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, val: ArrayBuffer) => { store.set(key, val); },
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
    const syn = vi.fn();
    const out = await synthesizeWithCache({ kv, lang: "en-US", term, provider: fakeProvider(syn) });
    expect(out).toBe(cached);
    expect(syn).not.toHaveBeenCalled();
  });

  it("on a miss, calls the provider, writes KV, and returns the bytes", async () => {
    const term = "world";
    const key = cacheKey("en-US", AZURE_PROVIDER_NAME, term);
    const { kv, store } = fakeKv();
    const fresh = new Uint8Array([7, 7, 7]).buffer;
    const syn = vi.fn(async () => fresh);
    const out = await synthesizeWithCache({ kv, lang: "en-US", term, provider: fakeProvider(syn as any) });
    expect(out).toBe(fresh);
    expect(syn).toHaveBeenCalledWith("world", "en-US");
    expect(store.get(key)).toBe(fresh);
  });

  it("returns null (and does not write KV) when the provider throws", async () => {
    const term = "boom";
    const { kv, store } = fakeKv();
    const syn = vi.fn(async () => { throw new Error("azure_500"); });
    const out = await synthesizeWithCache({ kv, lang: "en-US", term, provider: fakeProvider(syn as any) });
    expect(out).toBeNull();
    expect(store.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/tts.test.ts`
Expected: FAIL — `synthesizeWithCache` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/tts.ts`:

```ts
export async function synthesizeWithCache(opts: {
  kv: KVNamespace;
  lang: string;
  term: string;
  provider: TtsProvider;
}): Promise<ArrayBuffer | null> {
  const key = cacheKey(opts.lang, opts.provider.name, opts.term);
  const cached = await opts.kv.get(key, "arraybuffer");
  if (cached) return cached;
  try {
    const bytes = await opts.provider.synthesize(opts.term, opts.lang);
    await opts.kv.put(key, bytes);
    return bytes;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/tts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tts.ts test/tts.test.ts
git commit -m "feat(tts): synthesizeWithCache KV 命中/未命中/失败编排"
```

---

### Task 4: KV binding, Env, route wiring + `SELF.fetch` route tests

**Files:**
- Modify: `wrangler.toml` (add KV binding)
- Modify: `src/index.ts` (extend `Env`, mount router)
- Modify: `src/tts.ts` (append the `tts` Hono sub-router)
- Modify: `test/tts.test.ts` (append route tests via `SELF.fetch` + `env.AUDIO`)

**Interfaces:**
- Consumes: `validateTerm`, `synthesizeWithCache`, `makeAzureProvider` (Tasks 1–3); the worker `Env` (type from `src/index.ts`); miniflare-provided `AUDIO` KV (real, mutable in tests via `env.AUDIO`).
- Produces: `GET /api/tts?term=&lang=en-US` mounted on the worker; `Env` gains `AUDIO`/`AZURE_TTS_KEY`/`AZURE_TTS_REGION`.

- [ ] **Step 1: Write the failing tests**

Append to `test/tts.test.ts` (these go through the real worker via `SELF.fetch` and the real miniflare KV via `env.AUDIO`):

```ts
import { SELF, env } from "cloudflare:test";
import { cacheKey, AZURE_PROVIDER_NAME } from "../src/tts";

describe("GET /api/tts (route)", () => {
  it("returns 400 for a missing term", async () => {
    const res = await SELF.fetch("https://example.com/api/tts");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_term" });
  });

  it("returns 400 for an invalid term", async () => {
    const res = await SELF.fetch("https://example.com/api/tts?term=bad<word");
    expect(res.status).toBe(400);
  });

  it("returns cached mp3 with correct headers on a cache hit", async () => {
    const term = "apple";
    const key = cacheKey("en-US", AZURE_PROVIDER_NAME, term);
    const bytes = new Uint8Array([0x49, 0x44, 0x33, 0x04]).buffer; // "ID3"-ish mp3 magic
    await env.AUDIO.put(key, bytes);

    const res = await SELF.fetch("https://example.com/api/tts?term=apple");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const out = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(out)).toEqual([0x49, 0x44, 0x33, 0x04]);
  });

  it("returns 502 on a cache miss when Azure is not configured (no key in test env)", async () => {
    // term is cached from the previous test; use a fresh term to force a miss
    const res = await SELF.fetch("https://example.com/api/tts?term=missword_xyz");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "synthesis_failed" });
  });
});
```

> **Why no real Azure call here:** in the miniflare test environment `AZURE_TTS_KEY` is unset, so on a miss `AzureTtsProvider.synthesize` throws `azure_not_configured` **without** touching the network, yielding 502. The real provider HTTP behavior is already covered by the Task 2 unit tests with mocked `fetch`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/tts.test.ts`
Expected: FAIL — `/api/tts` route does not exist yet (404 / assets fallback).

- [ ] **Step 3: Add the KV binding to `wrangler.toml`**

Append to `wrangler.toml` (placeholder ids are fine for local/test; run the create command in Task 6 before deploy):

```toml
[[kv_namespaces]]
binding = "AUDIO"
id = "REPLACE_VIA_wrangler_kv_namespace_create"
preview_id = "REPLACE_VIA_wrangler_kv_namespace_create_preview"
```

- [ ] **Step 4: Extend `Env` and mount the router in `src/index.ts`**

Edit `src/index.ts`:

Replace the `Env` interface block:
```ts
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_TOKEN: string;
  AUDIO: KVNamespace;
  AZURE_TTS_KEY: string;
  AZURE_TTS_REGION: string;
}
```

Add the import next to the existing `import { kid } from "./kid";`:
```ts
import { tts } from "./tts";
```

Mount it (insert immediately after the `app.route("/api/admin", admin);` line, before the `app.all("*", ...)` fallback):
```ts
app.route("/api", tts);
```

- [ ] **Step 5: Add the `tts` Hono sub-router to `src/tts.ts`**

Append to `src/tts.ts`:

```ts
import { Hono } from "hono";
import type { Env } from "./index";

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
```

> The `import type { Env } from "./index"` is type-only (erased at compile), so the `index.ts` ↔ `tts.ts` import cycle is safe — it is the same pattern `kid.ts` already uses.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/tts.test.ts`
Expected: PASS (all four route tests, plus all earlier unit tests).

- [ ] **Step 7: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: all suites green (existing `api`/`srs`/`csv` tests still pass).

- [ ] **Step 8: Commit**

```bash
git add src/tts.ts src/index.ts wrangler.toml test/tts.test.ts
git commit -m "feat(tts): GET /api/tts 端点 + KV AUDIO 绑定 + Env"
```

---

### Task 5: Frontend `speak()` rewrite with fallback

**Files:**
- Modify: `public/app.js` (lines 24-30, the `speak` function). No other call sites change.

**Interfaces:**
- Consumes: `GET /api/tts?term=&lang=en-US` (from Task 4).
- Produces: same `speak(text)` signature so the three existing call sites (`public/app.js:116`, `:135`, `:141`) are unchanged.

> This repo has no frontend test harness; verification is manual via `npm run dev`. TDD step ordering is adjusted accordingly (implement, then manually verify), but the change is tiny and self-contained.

- [ ] **Step 1: Replace the `speak` function**

In `public/app.js`, replace this block (current lines 24-30):
```js
function speak(text) {
  if ("speechSynthesis" in window) {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    speechSynthesis.speak(u);
  }
}
```
with:
```js
function speak(text) {
  const url = `/api/tts?term=${encodeURIComponent(text)}&lang=en-US`;
  const a = new Audio(url);
  a.play().catch(() => {
    // 合成失败 / 网络失败：回退浏览器机械音，保证按钮永不哑
    if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US";
      speechSynthesis.speak(u);
    }
  });
}
```

- [ ] **Step 2: Manually verify via local dev**

Prerequisites: a working `/api/tts`. For local dev without Azure keys, cache-miss returns 502 and the frontend must fall back to `speechSynthesis` — verify that path first (no keys needed):

Run: `npm run dev`
1. Open the app, pick a kid, start a session.
2. On the spelling card, tap 🔊 → confirm a sound plays (will be the browser fallback until Azure is configured; the button must NOT be silent).
3. Submit an answer (correct or wrong) → confirm the auto-read-aloud still fires.

Then (only if Azure keys are set in `.dev.vars` per Task 6):
4. Open DevTools → Network. Tap 🔊 → confirm `GET /api/tts?term=...` returns 200 with `audio/mpeg`; first play synthesizes, second play of the same word is a fast KV cache hit.
5. Confirm the voice is the Jenny neural voice (not the old robot voice).

- [ ] **Step 3: Commit**

```bash
git add public/app.js
git commit -m "feat(py): speak() 走 /api/tts 神经语音,失败回退 speechSynthesis"
```

---

### Task 6: Deploy config runbook (KV namespace + secrets + `.dev.vars`)

**Files:**
- Modify: `wrangler.toml` (replace placeholder KV ids with real ones)
- Modify: `.dev.vars` (gitignored — add local Azure keys for `wrangler dev`)
- No source/test changes; this task's gate is operational verification.

**Interfaces:**
- Consumes: the `AUDIO` KV binding declared in Task 4; Azure Speech F0 resource (region + key) provisioned by hand on the Azure portal.
- Produces: a deployable worker with real KV namespace id + live secrets; local dev with keys.

- [ ] **Step 1: Create the KV namespaces and fill in real ids**

```bash
wrangler kv namespace create AUDIO
# copy the printed id -> wrangler.toml [[kv_namespaces]] id
wrangler kv namespace create AUDIO --preview
# copy the printed id -> wrangler.toml [[kv_namespaces]] preview_id
```

Replace both `REPLACE_VIA_*` placeholders in `wrangler.toml` with the printed ids.

- [ ] **Step 2: Provision Azure Speech F0 + inject secrets**

On the Azure portal: create a **Speech** resource, **F0 (free)** pricing tier, region **East Asia**. Copy **Key** and **Region** from "Keys and Endpoint".

Inject as Worker secrets (these are never written to the repo):
```bash
wrangler secret put AZURE_TTS_KEY     # paste the key, Enter
wrangler secret put AZURE_TTS_REGION  # type: eastasia, Enter
```

- [ ] **Step 3: Add local dev keys to `.dev.vars`**

Append to `.dev.vars` (already gitignored) so `wrangler dev` can synthesize locally:
```
AZURE_TTS_KEY=<same key>
AZURE_TTS_REGION=eastasia
```

- [ ] **Step 4: Verify the deploy end-to-end**

Run: `npm test` then `npm run dev`
1. `npm test` → all green (sanity before deploy).
2. `npm run dev`, open app, tap 🔊 on a word → confirm Jenny neural voice plays (Network shows `/api/tts` 200 `audio/mpeg`).
3. Tap the same word again → confirm near-instant playback (KV cache hit).
4. Verify the cached entry: `wrangler kv key list --binding=AUDIO --remote` shows a key shaped `audio:en-US:azure-jenny:<word>`.
5. Deploy: `npm run deploy`. Re-open the production URL and confirm pronunciation works there too.

- [ ] **Step 5: Commit the wrangler.toml id fill**

```bash
git add wrangler.toml
git commit -m "chore(tts): 填入 AUDIO KV namespace id"
```

---

## Self-Review Notes

- **Spec coverage:** §1 background → whole plan; §2 decisions (Azure F0 / Jenny / KV no-TTL versioned key / provider abstraction / browser fallback / no auth) → Tasks 2,3,4,5 + Global Constraints; §3 data flow → Tasks 3,4; §4 endpoint contract → Task 4 (statuses 400/200/502, headers, validation); §5 KV layer → Tasks 3,4; §6 provider + abstraction → Tasks 2,3; §7 frontend → Task 5; §8 config/secrets → Tasks 4,6; §9 error handling → Tasks 2,3,4,5; §10 testing → Tasks 1–4; §11 verification → Tasks 4,5,6; §12 YAGNI respected (no per-lang voice map, no single-flight, no preload).
- **Type consistency:** `TtsProvider`, `AZURE_PROVIDER_NAME`, `synthesizeWithCache`, `validateTerm`, `cacheKey`, `escapeXml`, `makeAzureProvider` names match across all tasks and tests. `Env` field names (`AUDIO`, `AZURE_TTS_KEY`, `AZURE_TTS_REGION`) match between `src/index.ts` and the provider/route. Status codes uniformly 400/200/502 across plan and spec.
- **No placeholders:** every code step contains runnable code; the only "placeholders" are intentional KV namespace ids filled in Task 6 Step 1.
