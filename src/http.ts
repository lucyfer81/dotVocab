import type { Context } from "hono";

// 统一的 JSON body 读取：解析失败返回 null（调用方回 400），
// 杜绝 c.req.json() 抛异常把坏请求变成 500。
export async function parseJsonBody<T>(c: Context): Promise<T | null> {
  try {
    return await c.req.json<T>();
  } catch {
    return null;
  }
}
