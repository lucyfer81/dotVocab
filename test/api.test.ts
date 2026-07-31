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

describe("kid: home + sessions", () => {
  beforeAll(async () => { await applySchema(); });

  it("GET /api/home returns stats + due_count + unit progress", async () => {
    const res = await SELF.fetch("https://example.com/api/home?user_id=1");
    const data = await json(res);
    expect(res.status).toBe(200);
    expect(data).toHaveProperty("stars");
    expect(data).toHaveProperty("streak_days");
    expect(data).toHaveProperty("due_count");
    expect(Array.isArray(data.units)).toBe(true);
  });

  it("GET /api/home with missing user_id => 400", async () => {
    const res = await SELF.fetch("https://example.com/api/home");
    expect(res.status).toBe(400);
  });

  it("GET /api/session/due returns only due words", async () => {
    const wid = await seedWord("dog", "狗");
    await env.DB.prepare(
      "INSERT INTO user_word_state (user_id, word_id, reps, interval_days, due_at, lapses) VALUES (1,?,0,0,0,0)"
    ).bind(wid).run();
    const res = await SELF.fetch("https://example.com/api/session/due?user_id=1");
    const data: any = await json(res);
    expect(res.status).toBe(200);
    expect(data.some((w: any) => w.term === "dog")).toBe(true);
  });

  it("GET /api/session/unit returns uncovered words; covered ones excluded", async () => {
    const u = await env.DB.prepare(
      "INSERT INTO units (book, unit) VALUES ('书A','Unit 1') RETURNING id"
    ).first<{ id: number }>();
    const w1 = await seedWord("elephant", "大象");
    const w2 = await seedWord("fish", "鱼");
    await env.DB.prepare("INSERT INTO unit_words (unit_id, word_id) VALUES (?,?),(?,?)").bind(u!.id, w1, u!.id, w2).run();
    await env.DB.prepare(
      "INSERT INTO user_unit_word_seen (user_id, unit_id, word_id, first_seen_at) VALUES (1,?,?,1)"
    ).bind(u!.id, w1).run();
    const res = await SELF.fetch("https://example.com/api/session/unit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: 1, unit_id: u!.id }),
    });
    const data: any = await json(res);
    const terms = data.map((w: any) => w.term);
    expect(terms).toContain("fish");
    expect(terms).not.toContain("elephant");
  });

  it("duplicate word across units is tested at least once per unit", async () => {
    const u1 = await env.DB.prepare("INSERT INTO units (book, unit) VALUES ('书','U1') RETURNING id").first<{ id: number }>();
    const u2 = await env.DB.prepare("INSERT INTO units (book, unit) VALUES ('书','U2') RETURNING id").first<{ id: number }>();
    const wid = await seedWord("grape", "葡萄");
    await env.DB.prepare("INSERT INTO unit_words (unit_id, word_id) VALUES (?,?),(?,?)").bind(u1!.id, wid, u2!.id, wid).run();
    await env.DB.prepare(
      "INSERT INTO user_unit_word_seen (user_id, unit_id, word_id, first_seen_at) VALUES (1,?,?,1)"
    ).bind(u1!.id, wid).run();
    const res = await SELF.fetch("https://example.com/api/session/unit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: 1, unit_id: u2!.id }),
    });
    const data: any = await json(res);
    expect(data.some((w: any) => w.term === "grape")).toBe(true);
  });
});

describe("admin: units + import", () => {
  beforeAll(async () => { await applySchema(); });

  it("POST /api/admin/units creates a unit", async () => {
    const res = await SELF.fetch("https://example.com/api/admin/units", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ book: "人教PEP三上", unit: "Unit 1", sort_key: 1 }),
    });
    const data = await json(res);
    expect(res.status).toBe(200);
    expect(data.id).toBeGreaterThan(0);
  });

  it("POST /api/admin/import upserts words, links to unit, dedupes repeats", async () => {
    const u = await env.DB.prepare(
      "INSERT INTO units (book, unit) VALUES ('书X','Unit 1') RETURNING id"
    ).first<{ id: number }>();
    const csv = "apple,苹果,n\nbanana,香蕉\napple,苹果"; // apple twice
    const res = await SELF.fetch("https://example.com/api/admin/import", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ unit_id: u!.id, csv }),
    });
    const data: any = await json(res);
    expect(res.status).toBe(200);
    expect(data.inserted).toBe(2);     // apple + banana
    expect(data.updated).toBe(1);      // apple second occurrence updates
    expect(data.linked).toBe(2);       // two distinct words linked to unit
    const cnt = await env.DB.prepare(
      "SELECT COUNT(*) as n FROM unit_words WHERE unit_id=?"
    ).bind(u!.id).first<{ n: number }>();
    expect(cnt?.n).toBe(2);
  });

  it("import reports row errors but still imports good rows", async () => {
    const u = await env.DB.prepare(
      "INSERT INTO units (book, unit) VALUES ('书Y','Unit 1') RETURNING id"
    ).first<{ id: number }>();
    const csv = "cat,猫\nbad"; // line 2 missing meaning
    const res = await SELF.fetch("https://example.com/api/admin/import", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ unit_id: u!.id, csv }),
    });
    const data: any = await json(res);
    expect(data.inserted).toBe(1);
    expect(data.errors.length).toBe(1);
    expect(data.errors[0].line).toBe(2);
  });
});

describe("admin: words CRUD + progress", () => {
  beforeAll(async () => { await applySchema(); });

  it("GET /api/admin/words lists words", async () => {
    await seedWord("listword", "列词");
    const res = await SELF.fetch("https://example.com/api/admin/words", {
      headers: { "x-admin-token": adminToken },
    });
    const data: any = await json(res);
    expect(res.status).toBe(200);
    expect(data.some((w: any) => w.term === "listword")).toBe(true);
  });

  it("PUT /api/admin/words/:id updates meaning", async () => {
    const wid = await seedWord("editme", "旧");
    const res = await SELF.fetch(`https://example.com/api/admin/words/${wid}`, {
      method: "PUT", headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ pos: "n", meaning_cn: "新", example_en: null, example_cn: null }),
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT meaning_cn FROM words WHERE id=?").bind(wid).first<{ meaning_cn: string }>();
    expect(row?.meaning_cn).toBe("新");
  });

  it("DELETE /api/admin/words/:id removes the word", async () => {
    const wid = await seedWord("delme", "删");
    const res = await SELF.fetch(`https://example.com/api/admin/words/${wid}`, {
      method: "DELETE", headers: { "x-admin-token": adminToken },
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT id FROM words WHERE id=?").bind(wid).first();
    expect(row).toBeNull();
  });

  it("GET /api/admin/progress returns both kids", async () => {
    const res = await SELF.fetch("https://example.com/api/admin/progress", {
      headers: { "x-admin-token": adminToken },
    });
    const data: any = await json(res);
    expect(res.status).toBe(200);
    expect(data.length).toBe(2);
    expect(data.every((u: any) => "stars" in u && "mastered" in u)).toBe(true);
  });
});

describe("admin: word delete cascades to avoid orphan inflation", () => {
  beforeAll(async () => { await applySchema(); });

  it("deleting a word removes its unit_links + state; home total no longer inflated", async () => {
    const u = await env.DB.prepare(
      "INSERT INTO units (book, unit) VALUES ('书D','U1') RETURNING id"
    ).first<{ id: number }>();
    const wid = await seedWord("delcascade", "删词");
    await env.DB.prepare("INSERT INTO unit_words (unit_id, word_id) VALUES (?,?)").bind(u!.id, wid).run();
    await env.DB.prepare(
      "INSERT INTO user_word_state (user_id, word_id, reps, interval_days, due_at, lapses) VALUES (1,?,1,1,0,0)"
    ).bind(wid).run();

    let home: any = await json(await SELF.fetch("https://example.com/api/home?user_id=1"));
    expect(home.units.find((x: any) => x.unit_id === u!.id)?.total).toBe(1);

    const res = await SELF.fetch(`https://example.com/api/admin/words/${wid}`, {
      method: "DELETE", headers: { "x-admin-token": adminToken },
    });
    expect(res.status).toBe(200);

    expect(await env.DB.prepare("SELECT word_id FROM unit_words WHERE word_id=?").bind(wid).first()).toBeNull();
    expect(await env.DB.prepare("SELECT word_id FROM user_word_state WHERE word_id=?").bind(wid).first()).toBeNull();

    home = await json(await SELF.fetch("https://example.com/api/home?user_id=1"));
    expect(home.units.find((x: any) => x.unit_id === u!.id)?.total).toBe(0);
  });
});

describe("admin: reset-progress", () => {
  beforeAll(async () => { await applySchema(); });

  async function seedCoverage(userId: number, unitId: number, wordIds: number[]) {
    for (const wid of wordIds) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO user_unit_word_seen (user_id, unit_id, word_id, first_seen_at) VALUES (?,?,?,1)"
      ).bind(userId, unitId, wid).run();
    }
  }
  async function countCoverage(userId: number) {
    const r = await env.DB.prepare(
      "SELECT COUNT(*) as n FROM user_unit_word_seen WHERE user_id=?"
    ).bind(userId).first<{ n: number }>();
    return r?.n ?? 0;
  }

  it("rejects without token => 401", async () => {
    const res = await SELF.fetch("https://example.com/api/admin/reset-progress", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "global", user_ids: [901] }),
    });
    expect(res.status).toBe(401);
  });

  it("validates params => 400 (bad scope / unit-missing-unit_id / empty user_ids / book-missing-book)", async () => {
    const h = { "content-type": "application/json", "x-admin-token": adminToken };
    const base = "https://example.com/api/admin/reset-progress";
    const bad1 = await SELF.fetch(base, { method: "POST", headers: h, body: JSON.stringify({ scope: "weird", user_ids: [901] }) });
    expect(bad1.status).toBe(400);
    const bad2 = await SELF.fetch(base, { method: "POST", headers: h, body: JSON.stringify({ scope: "unit", user_ids: [901] }) });
    expect(bad2.status).toBe(400);
    const bad3 = await SELF.fetch(base, { method: "POST", headers: h, body: JSON.stringify({ scope: "global", user_ids: [] }) });
    expect(bad3.status).toBe(400);
    const bad4 = await SELF.fetch(base, { method: "POST", headers: h, body: JSON.stringify({ scope: "book", user_ids: [901] }) });
    expect(bad4.status).toBe(400);
  });

  it("unit scope clears only that unit's coverage; leaves state + stats + other unit", async () => {
    const ua = await env.DB.prepare("INSERT INTO units (book, unit) VALUES ('重置书','U-A') RETURNING id").first<{ id: number }>();
    const ub = await env.DB.prepare("INSERT INTO units (book, unit) VALUES ('重置书','U-B') RETURNING id").first<{ id: number }>();
    const w1 = await seedWord("rscope_a1", "甲");
    const w2 = await seedWord("rscope_a2", "乙");
    const w3 = await seedWord("rscope_b1", "丙");
    await env.DB.prepare("INSERT INTO unit_words (unit_id, word_id) VALUES (?,?),(?,?),(?,?)")
      .bind(ua!.id, w1, ua!.id, w2, ub!.id, w3).run();
    await seedCoverage(901, ua!.id, [w1, w2]);
    await seedCoverage(901, ub!.id, [w3]);
    await env.DB.prepare(
      "INSERT INTO user_word_state (user_id, word_id, reps, interval_days, due_at, lapses) VALUES (901,?,3,30,0,0)"
    ).bind(w1).run();
    await env.DB.prepare(
      "INSERT INTO user_stats (user_id, stars, streak_days, last_play_date) VALUES (901,50,7,'2026-07-31')"
    ).run();

    const res = await SELF.fetch("https://example.com/api/admin/reset-progress", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ scope: "unit", unit_id: ua!.id, user_ids: [901] }),
    });
    const data: any = await json(res);
    expect(res.status).toBe(200);
    expect(data.deleted).toBe(2);

    const aLeft = await env.DB.prepare("SELECT COUNT(*) as n FROM user_unit_word_seen WHERE user_id=901 AND unit_id=?").bind(ua!.id).first<{ n: number }>();
    expect(aLeft?.n).toBe(0);
    const bLeft = await env.DB.prepare("SELECT COUNT(*) as n FROM user_unit_word_seen WHERE user_id=901 AND unit_id=?").bind(ub!.id).first<{ n: number }>();
    expect(bLeft?.n).toBe(1);
    const st = await env.DB.prepare("SELECT reps FROM user_word_state WHERE user_id=901 AND word_id=?").bind(w1).first<{ reps: number }>();
    expect(st?.reps).toBe(3);
    const stats = await env.DB.prepare("SELECT stars FROM user_stats WHERE user_id=901").first<{ stars: number }>();
    expect(stats?.stars).toBe(50);
  });

  it("book scope clears all units in that book; other book intact", async () => {
    const u1 = await env.DB.prepare("INSERT INTO units (book, unit) VALUES ('重置书X','BX1') RETURNING id").first<{ id: number }>();
    const u2 = await env.DB.prepare("INSERT INTO units (book, unit) VALUES ('重置书X','BX2') RETURNING id").first<{ id: number }>();
    const uY = await env.DB.prepare("INSERT INTO units (book, unit) VALUES ('重置书Y','BY1') RETURNING id").first<{ id: number }>();
    const w1 = await seedWord("rbook_a", "书甲");
    const w2 = await seedWord("rbook_b", "书乙");
    const w3 = await seedWord("rbook_c", "书丙");
    await env.DB.prepare("INSERT INTO unit_words (unit_id, word_id) VALUES (?,?),(?,?),(?,?)")
      .bind(u1!.id, w1, u2!.id, w2, uY!.id, w3).run();
    await seedCoverage(902, u1!.id, [w1]);
    await seedCoverage(902, u2!.id, [w2]);
    await seedCoverage(902, uY!.id, [w3]);

    const res = await SELF.fetch("https://example.com/api/admin/reset-progress", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ scope: "book", book: "重置书X", user_ids: [902] }),
    });
    const data: any = await json(res);
    expect(res.status).toBe(200);
    expect(data.deleted).toBe(2);
    const xLeft = await env.DB.prepare("SELECT COUNT(*) as n FROM user_unit_word_seen WHERE user_id=902 AND unit_id IN (?,?)").bind(u1!.id, u2!.id).first<{ n: number }>();
    expect(xLeft?.n).toBe(0);
    const yLeft = await env.DB.prepare("SELECT COUNT(*) as n FROM user_unit_word_seen WHERE user_id=902 AND unit_id=?").bind(uY!.id).first<{ n: number }>();
    expect(yLeft?.n).toBe(1);
  });

  it("global scope clears all coverage for the user; leaves state + stats", async () => {
    const u = await env.DB.prepare("INSERT INTO units (book, unit) VALUES ('重置书G','G1') RETURNING id").first<{ id: number }>();
    const w1 = await seedWord("rglob_a", "全甲");
    const w2 = await seedWord("rglob_b", "全乙");
    await env.DB.prepare("INSERT INTO unit_words (unit_id, word_id) VALUES (?,?),(?,?)").bind(u!.id, w1, u!.id, w2).run();
    await seedCoverage(903, u!.id, [w1, w2]);
    await env.DB.prepare(
      "INSERT INTO user_word_state (user_id, word_id, reps, interval_days, due_at, lapses) VALUES (903,?,2,4,0,0)"
    ).bind(w1).run();
    await env.DB.prepare(
      "INSERT INTO user_stats (user_id, stars, streak_days, last_play_date) VALUES (903,9,2,'2026-07-31')"
    ).run();

    const res = await SELF.fetch("https://example.com/api/admin/reset-progress", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ scope: "global", user_ids: [903] }),
    });
    const data: any = await json(res);
    expect(res.status).toBe(200);
    expect(data.deleted).toBe(2);
    expect(await countCoverage(903)).toBe(0);
    const st = await env.DB.prepare("SELECT reps FROM user_word_state WHERE user_id=903 AND word_id=?").bind(w1).first<{ reps: number }>();
    expect(st?.reps).toBe(2);
    const stats = await env.DB.prepare("SELECT stars FROM user_stats WHERE user_id=903").first<{ stars: number }>();
    expect(stats?.stars).toBe(9);
  });

  it("user_ids targets only named kids (single then both); deleted counts matched rows", async () => {
    const u = await env.DB.prepare("INSERT INTO units (book, unit) VALUES ('重置书K','K1') RETURNING id").first<{ id: number }>();
    const w1 = await seedWord("rkid_a", "孩甲");
    await env.DB.prepare("INSERT INTO unit_words (unit_id, word_id) VALUES (?,?)").bind(u!.id, w1).run();
    await seedCoverage(904, u!.id, [w1]);
    await seedCoverage(905, u!.id, [w1]);

    await SELF.fetch("https://example.com/api/admin/reset-progress", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ scope: "unit", unit_id: u!.id, user_ids: [904] }),
    });
    const a = await env.DB.prepare("SELECT COUNT(*) as n FROM user_unit_word_seen WHERE user_id=904 AND unit_id=?").bind(u!.id).first<{ n: number }>();
    const b = await env.DB.prepare("SELECT COUNT(*) as n FROM user_unit_word_seen WHERE user_id=905 AND unit_id=?").bind(u!.id).first<{ n: number }>();
    expect(a?.n).toBe(0);
    expect(b?.n).toBe(1);

    const res = await SELF.fetch("https://example.com/api/admin/reset-progress", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ scope: "unit", unit_id: u!.id, user_ids: [904, 905] }),
    });
    const data: any = await json(res);
    expect(res.status).toBe(200);
    expect(data.deleted).toBe(1); // 904 已清空，只剩 905 一行
    const b2 = await env.DB.prepare("SELECT COUNT(*) as n FROM user_unit_word_seen WHERE user_id=905 AND unit_id=?").bind(u!.id).first<{ n: number }>();
    expect(b2?.n).toBe(0);
  });
});
