import { createMiddleware } from "hono/factory";
import type { Env } from "./index";

async function sha256Bytes(s: string): Promise<Uint8Array> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return new Uint8Array(d);
}

export const adminAuth = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const token = c.req.header("x-admin-token") ?? "";
  if (!c.env.ADMIN_TOKEN) return c.json({ error: "未授权" }, 401);
  // 先哈希到定长再逐字节比较：避免逐字符短路比较泄露前缀信息
  const [a, b] = [await sha256Bytes(token), await sha256Bytes(c.env.ADMIN_TOKEN)];
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= a[i] ^ b[i];
  if (diff !== 0) return c.json({ error: "未授权" }, 401);
  await next();
});
