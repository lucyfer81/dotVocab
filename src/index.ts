import { Hono } from "hono";
import { kid } from "./kid";
import { admin } from "./admin";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_TOKEN: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

app.route("/api", kid);
app.route("/api/admin", admin);

// Fallback: serve static assets for everything else.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
