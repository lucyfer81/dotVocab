import { createMiddleware } from "hono/factory";
import type { Env } from "./index";

export const adminAuth = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const token = c.req.header("x-admin-token");
  if (!c.env.ADMIN_TOKEN || token !== c.env.ADMIN_TOKEN) {
    return c.json({ error: "未授权" }, 401);
  }
  await next();
});
