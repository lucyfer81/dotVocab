import { describe, it, expect, beforeAll } from "vitest";
import { SELF, env } from "cloudflare:test";
import { SCHEMA_SQL } from "./schema";

async function applySchema() {
  // D1Database.exec() trips an instrumentation bug under the current workerd
  // (aggregateD1Meta reads meta.duration from an undefined meta). Splitting the
  // schema into statements and running them via batch() sidesteps it while
  // still applying the whole schema atomically.
  const db = env.DB as D1Database;
  const statements = SCHEMA_SQL.split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  await db.batch(statements.map((s) => db.prepare(s)));
}

async function json(res: Response) {
  return await res.json();
}

describe("health", () => {
  beforeAll(async () => {
    await applySchema();
  });
  it("returns ok", async () => {
    const res = await SELF.fetch("https://example.com/api/health");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true });
  });
});
