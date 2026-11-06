import { Hono } from "hono";
import { kid } from "./kid";
import { admin } from "./admin";
import { tts } from "./tts";
import { poc, poc1 } from "./poc";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_TOKEN: string;
  AUDIO: KVNamespace;
  AZURE_TTS_KEY: string;
  AZURE_TTS_REGION: string;
  AZURE_STT_KEY?: string;
  AZURE_STT_REGION?: string;
  AI: Ai;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

app.route("/api", kid);
app.route("/api/admin", admin);
app.route("/api", tts);
// POC 路由(/poc、/poc1 页面 + /api/poc/asr、/api/poc1/asr)需挂在 /api/* 404 兜底之前。
app.route("/", poc);
app.route("/", poc1);

// API 空间内的未知路径/方法统一 JSON 404：不能漏给 SPA 兜底吃掉（会变 200 HTML）。
app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

// Fallback: serve static assets for everything else.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
