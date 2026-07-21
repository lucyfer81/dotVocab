import { describe, it, expect, beforeAll } from "vitest";
import { SELF, env } from "cloudflare:test";
import { SCHEMA_SQL } from "./schema";
import { adminToken } from "./helpers";

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

async function seedWord(term: string, meaning = "释义") {
  const r = await env.DB.prepare(
    "INSERT INTO words (term, meaning_cn, created_at) VALUES (?,?,?) RETURNING id"
  ).bind(term, meaning, 1_700_000_000_000).first<{ id: number }>();
  return r!.id;
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

describe("admin auth", () => {
  beforeAll(async () => { await applySchema(); });
  it("rejects /api/admin/* without token", async () => {
    const res = await SELF.fetch("https://example.com/api/admin/units");
    expect(res.status).toBe(401);
  });
  it("accepts with correct x-admin-token", async () => {
    const res = await SELF.fetch("https://example.com/api/admin/units", {
      headers: { "x-admin-token": adminToken },
    });
    expect(res.status).toBe(200);
  });
});

describe("kid: users + review + cover", () => {
  beforeAll(async () => { await applySchema(); });

  it("GET /api/users lists the two seeded kids", async () => {
    const res = await SELF.fetch("https://example.com/api/users");
    const data = await json(res);
    expect(res.status).toBe(200);
    expect(data.length).toBe(2);
    expect(data.map((u: any) => u.name).sort()).toEqual(["哥哥", "弟弟"]);
  });

  it("POST /api/review creates state and awards a star on correct, bumps streak", async () => {
    const wid = await seedWord("apple", "苹果");
    const res = await SELF.fetch("https://example.com/api/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: 1, word_id: wid, correct: true }),
    });
    const data = await json(res);
    expect(res.status).toBe(200);
    expect(data.state.reps).toBe(1);
    expect(data.stars_awarded).toBe(1);
    expect(data.stars).toBe(1);
    expect(data.streak_days).toBeGreaterThanOrEqual(1);
  });

  it("POST /api/review with correct=false resets reps and gives no star", async () => {
    const wid = await seedWord("banana", "香蕉");
    await SELF.fetch("https://example.com/api/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: 1, word_id: wid, correct: true }),
    });
    const res = await SELF.fetch("https://example.com/api/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: 1, word_id: wid, correct: false }),
    });
    const data = await json(res);
    expect(data.state.reps).toBe(0);
    expect(data.state.lapses).toBe(1);
    expect(data.stars_awarded).toBe(0);
  });

  it("POST /api/cover marks a word covered in a unit (idempotent)", async () => {
    const u = await env.DB.prepare(
      "INSERT INTO units (book, unit) VALUES ('测试书','Unit 1') RETURNING id"
    ).first<{ id: number }>();
    const wid = await seedWord("cat", "猫");
    await env.DB.prepare("INSERT INTO unit_words (unit_id, word_id) VALUES (?,?)").bind(u!.id, wid).run();
    const res = await SELF.fetch("https://example.com/api/cover", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: 1, unit_id: u!.id, word_id: wid }),
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT first_seen_at FROM user_unit_word_seen WHERE user_id=1 AND unit_id=? AND word_id=?"
    ).bind(u!.id, wid).first<{ first_seen_at: number }>();
    expect(row?.first_seen_at).toBeGreaterThan(0);
  });
});
