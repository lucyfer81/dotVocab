import { Hono } from "hono";
import { kid } from "./kid";
import { admin } from "./admin";
import { tts } from "./tts";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_TOKEN: string;
  AUDIO: KVNamespace;
  AZURE_TTS_KEY: string;
  AZURE_TTS_REGION: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

app.route("/api", kid);
app.route("/api/admin", admin);
app.route("/api", tts);

// API 空间内的未知路径/方法统一 JSON 404：不能漏给 SPA 兜底吃掉（会变 200 HTML）。
app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

// Fallback: serve static assets for everything else.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
