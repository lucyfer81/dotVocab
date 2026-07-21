import { Hono } from "hono";
import { adminAuth } from "./auth";
import { kid } from "./kid";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_TOKEN: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

app.route("/api", kid);

// Placeholder so the auth gate is testable; full admin routes replace this in a later unit.
const adminPlaceholder = new Hono<{ Bindings: Env }>();
adminPlaceholder.use("*", adminAuth);
adminPlaceholder.get("/units", (c) => c.json([]));
app.route("/api/admin", adminPlaceholder);

// Fallback: serve static assets for everything else.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
