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

  it("review rejects non-boolean correct (B2)", async () => {
    const wid = await seedWord("boolguard", "布尔");
    for (const correct of ["false", "true", 1, null]) {
      const body: Record<string, unknown> = { user_id: 1, word_id: wid };
      if (correct !== null) body.correct = correct; // null 场景=缺失字段
      const res = await SELF.fetch("https://example.com/api/review", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    // 确认没有任何状态被写入（错误请求不得产生 lapses）
    const row = await env.DB.prepare(
      "SELECT reps, lapses FROM user_word_state WHERE user_id=1 AND word_id=?"
    ).bind(wid).first();
    expect(row).toBeNull();
  });

  it("review rejects malformed JSON with 400, not 500 (B5)", async () => {
    const res = await SELF.fetch("https://example.com/api/review", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{bad json",
    });
    expect(res.status).toBe(400);
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

describe("kid: review/cover input validation (no orphan rows)", () => {
  beforeAll(async () => { await applySchema(); });

  it("POST /api/review with unknown user_id => 404, writes nothing", async () => {
    const wid = await seedWord("vuser_word", "验用户");
    const res = await SELF.fetch("https://example.com/api/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: 424242, word_id: wid, correct: true }),
    });
    expect(res.status).toBe(404);
    expect(await env.DB.prepare("SELECT user_id FROM user_stats WHERE user_id=424242").first()).toBeNull();
    expect(await env.DB.prepare("SELECT user_id FROM user_word_state WHERE user_id=424242").first()).toBeNull();
  });

  it("POST /api/review with unknown word_id => 404, writes nothing", async () => {
    const res = await SELF.fetch("https://example.com/api/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: 1, word_id: 987654, correct: true }),
    });
    expect(res.status).toBe(404);
    expect(await env.DB.prepare("SELECT user_id FROM user_word_state WHERE user_id=1 AND word_id=987654").first()).toBeNull();
  });

  it("POST /api/cover with unknown user/unit/word => 404, writes nothing", async () => {
    const h = { "content-type": "application/json" };
    const wid = await seedWord("vcover_word", "验覆盖");
    const u = await env.DB.prepare("INSERT INTO units (book, unit) VALUES ('验证书','U1') RETURNING id").first<{ id: number }>();
    const cases = [
      { user_id: 424243, unit_id: u!.id, word_id: wid }, // unknown user
      { user_id: 1, unit_id: 987654, word_id: wid },     // unknown unit
      { user_id: 1, unit_id: u!.id, word_id: 987654 },   // unknown word
    ];
    for (const body of cases) {
      const res = await SELF.fetch("https://example.com/api/cover", { method: "POST", headers: h, body: JSON.stringify(body) });
      expect(res.status).toBe(404);
    }
    expect(await env.DB.prepare("SELECT user_id FROM user_unit_word_seen WHERE user_id=424243").first()).toBeNull();
    expect(await env.DB.prepare(
      "SELECT word_id FROM user_unit_word_seen WHERE user_id=1 AND unit_id=? AND word_id=?"
    ).bind(u!.id, wid).first()).toBeNull();
  });
});

describe("kid: stats updates are atomic (no lost stars)", () => {
  beforeAll(async () => { await applySchema(); });

  it("concurrent correct reviews award every star", async () => {
    const before = await env.DB.prepare("SELECT stars FROM user_stats WHERE user_id=2").first<{ stars: number }>();
    const base = before?.stars ?? 0;
    const words = [
      await seedWord("conc_a", "并甲"),
      await seedWord("conc_b", "并乙"),
      await seedWord("conc_c", "并丙"),
      await seedWord("conc_d", "并丁"),
      await seedWord("conc_e", "并戊"),
    ];
    await Promise.all(words.map((wid) =>
      SELF.fetch("https://example.com/api/review", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_id: 2, word_id: wid, correct: true }),
      })
    ));
    const after = await env.DB.prepare("SELECT stars FROM user_stats WHERE user_id=2").first<{ stars: number }>();
    expect(after?.stars ?? 0).toBe(base + words.length);
  });

  it("streak still bumps on a new day after the atomic rewrite", async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
    await env.DB.prepare(
      "INSERT INTO user_stats (user_id, stars, streak_days, last_play_date) VALUES (1, 10, 3, ?1) " +
      "ON CONFLICT(user_id) DO UPDATE SET stars=10, streak_days=3, last_play_date=?1"
    ).bind(yesterday).run();
    const wid = await seedWord("streak_next_day", "连击词");
    const res = await SELF.fetch("https://example.com/api/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: 1, word_id: wid, correct: true }),
    });
    const data = await json(res);
    expect(data.streak_days).toBe(4);
    expect(data.stars).toBe(11);
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

  it("validates params => 400 (bad scope / unit-missing-unit_id / empty or non-pos-int user_ids / book-missing-book)", async () => {
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
    // user_ids elements must be positive integers (guards the parameterized IN list)
    const bad5 = await SELF.fetch(base, { method: "POST", headers: h, body: JSON.stringify({ scope: "global", user_ids: [1.5] }) });
    expect(bad5.status).toBe(400);
    const bad6 = await SELF.fetch(base, { method: "POST", headers: h, body: JSON.stringify({ scope: "global", user_ids: [0] }) });
    expect(bad6.status).toBe(400);
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

  async function seedState(userId: number, wordId: number, reps = 3) {
    await env.DB.prepare(
      "INSERT INTO user_word_state (user_id, word_id, reps, interval_days, due_at, lapses) VALUES (?,?,?,30,0,0)"
    ).bind(userId, wordId, reps).run();
  }
  async function seedStats(userId: number, stars = 50, streak = 7) {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO user_stats (user_id, stars, streak_days, last_play_date) VALUES (?,?,?,'2026-07-31')"
    ).bind(userId, stars, streak).run();
  }

  it("deep+unit clears coverage + that unit's word state only + resets stats", async () => {
    const ua = await env.DB.prepare("INSERT INTO units (book, unit) VALUES ('深 reset 书','DU-A') RETURNING id").first<{ id: number }>();
    const ub = await env.DB.prepare("INSERT INTO units (book, unit) VALUES ('深 reset 书','DU-B') RETURNING id").first<{ id: number }>();
    const w1 = await seedWord("deep_a1", "深甲");
    const w2 = await seedWord("deep_a2", "深乙");
    const w3 = await seedWord("deep_b1", "深丙");
    await env.DB.prepare("INSERT INTO unit_words (unit_id, word_id) VALUES (?,?),(?,?),(?,?)")
      .bind(ua!.id, w1, ua!.id, w2, ub!.id, w3).run();
    await seedCoverage(906, ua!.id, [w1, w2]);
    await seedCoverage(906, ub!.id, [w3]);
    await seedState(906, w1);
    await seedState(906, w2);
    await seedState(906, w3);
    await seedStats(906);

    const res = await SELF.fetch("https://example.com/api/admin/reset-progress", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ scope: "unit", unit_id: ua!.id, user_ids: [906], deep: true }),
    });
    const data: any = await json(res);
    expect(res.status).toBe(200);
    expect(data.deleted).toBe(2);
    expect(data.state_deleted).toBe(2);
    expect(data.stats_reset).toBe(1);

    const states = await env.DB.prepare(
      "SELECT word_id FROM user_word_state WHERE user_id=906 ORDER BY word_id"
    ).all<{ word_id: number }>();
    expect(states.results.map((r: { word_id: number }) => r.word_id)).toEqual([w3]); // 仅另一单元的词保留
    const stats = await env.DB.prepare("SELECT stars, streak_days, last_play_date FROM user_stats WHERE user_id=906").first<any>();
    expect(stats?.stars).toBe(0);
    expect(stats?.streak_days).toBe(0);
    expect(stats?.last_play_date).toBeNull();
  });

  it("deep+book clears state for that book's words only; other book intact", async () => {
    const u1 = await env.DB.prepare("INSERT INTO units (book, unit) VALUES ('深 reset 书X','DBX1') RETURNING id").first<{ id: number }>();
    const uY = await env.DB.prepare("INSERT INTO units (book, unit) VALUES ('深 reset 书Y','DBY1') RETURNING id").first<{ id: number }>();
    const w1 = await seedWord("deepbook_a", "深书甲");
    const w2 = await seedWord("deepbook_b", "深书乙");
    await env.DB.prepare("INSERT INTO unit_words (unit_id, word_id) VALUES (?,?),(?,?)")
      .bind(u1!.id, w1, uY!.id, w2).run();
    await seedCoverage(907, u1!.id, [w1]);
    await seedCoverage(907, uY!.id, [w2]);
    await seedState(907, w1);
    await seedState(907, w2);
    await seedStats(907, 8, 2);

    const res = await SELF.fetch("https://example.com/api/admin/reset-progress", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ scope: "book", book: "深 reset 书X", user_ids: [907], deep: true }),
    });
    const data: any = await json(res);
    expect(res.status).toBe(200);
    expect(data.deleted).toBe(1);
    expect(data.state_deleted).toBe(1);
    expect(data.stats_reset).toBe(1);

    const st = await env.DB.prepare("SELECT reps FROM user_word_state WHERE user_id=907 AND word_id=?").bind(w2).first<{ reps: number }>();
    expect(st?.reps).toBe(3); // 其他课本的掌握度保留
  });

  it("deep+global clears all state + resets stats; non-deep leaves them intact", async () => {
    const u = await env.DB.prepare("INSERT INTO units (book, unit) VALUES ('深 reset 书G','DG1') RETURNING id").first<{ id: number }>();
    const w1 = await seedWord("deepglob_a", "深全甲");
    await env.DB.prepare("INSERT INTO unit_words (unit_id, word_id) VALUES (?,?)").bind(u!.id, w1).run();
    await seedCoverage(908, u!.id, [w1]);
    await seedState(908, w1, 5);
    await seedStats(908, 99, 12);

    // 非 deep：只清覆盖，掌握度与星星保留
    const r1 = await SELF.fetch("https://example.com/api/admin/reset-progress", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ scope: "global", user_ids: [908] }),
    });
    const d1: any = await json(r1);
    expect(d1.deleted).toBe(1);
    expect(d1.state_deleted).toBe(0);
    expect(d1.stats_reset).toBe(0);
    let st = await env.DB.prepare("SELECT reps FROM user_word_state WHERE user_id=908 AND word_id=?").bind(w1).first<{ reps: number }>();
    expect(st?.reps).toBe(5);

    // deep：全清
    await seedCoverage(908, u!.id, [w1]);
    const r2 = await SELF.fetch("https://example.com/api/admin/reset-progress", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ scope: "global", user_ids: [908], deep: true }),
    });
    const d2: any = await json(r2);
    expect(d2.deleted).toBe(1);
    expect(d2.state_deleted).toBe(1);
    expect(d2.stats_reset).toBe(1);
    st = await env.DB.prepare("SELECT reps FROM user_word_state WHERE user_id=908 AND word_id=?").bind(w1).first<{ reps: number }>();
    expect(st).toBeNull();
    const stats = await env.DB.prepare("SELECT stars, streak_days FROM user_stats WHERE user_id=908").first<any>();
    expect(stats?.stars).toBe(0);
    expect(stats?.streak_days).toBe(0);
  });
});

describe("kid: wrong-answer events (mistake book logging)", () => {
  beforeAll(async () => { await applySchema(); });

  async function countEvents() {
    const r = await env.DB.prepare("SELECT COUNT(*) as n FROM wrong_answer_events").first<{ n: number }>();
    return r?.n ?? 0;
  }

  it("correct=false records an event with answer + source; correct=true records nothing", async () => {
    const before = await countEvents();
    const wid = await seedWord("evt_wrong", "事甲");
    const res = await SELF.fetch("https://example.com/api/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: 1, word_id: wid, correct: false, source: "daily", answer: "evt_rong" }),
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT user_id, word_id, answer, source FROM wrong_answer_events ORDER BY id DESC LIMIT 1"
    ).first<any>();
    expect(row?.user_id).toBe(1);
    expect(row?.word_id).toBe(wid);
    expect(row?.answer).toBe("evt_rong");
    expect(row?.source).toBe("daily");

    const wid2 = await seedWord("evt_right", "事乙");
    const res2 = await SELF.fetch("https://example.com/api/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: 1, word_id: wid2, correct: true, source: "daily", answer: "ignored" }),
    });
    expect(res2.status).toBe(200);
    expect(await countEvents()).toBe(before + 1); // 只有答错那一条
  });

  it("legacy payload without source/answer stores NULLs", async () => {
    const wid = await seedWord("evt_legacy", "事丙");
    const res = await SELF.fetch("https://example.com/api/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: 1, word_id: wid, correct: false }),
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT answer, source FROM wrong_answer_events ORDER BY id DESC LIMIT 1"
    ).first<any>();
    expect(row?.answer).toBeNull();
    expect(row?.source).toBeNull();
  });

  it("invalid source stored as NULL; overlong answer truncated to 100 chars", async () => {
    const wid = await seedWord("evt_edge", "事丁");
    const long = "a".repeat(150);
    await SELF.fetch("https://example.com/api/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: 1, word_id: wid, correct: false, source: "cheat", answer: long }),
    });
    const row = await env.DB.prepare(
      "SELECT answer, source FROM wrong_answer_events ORDER BY id DESC LIMIT 1"
    ).first<any>();
    expect(row?.source).toBeNull();
    expect((row?.answer as string)?.length).toBe(100);
  });
});

describe("kid: mistake book derived queue + home count", () => {
  beforeAll(async () => { await applySchema(); });
  const h = { "content-type": "application/json" };
  const post = (url: string, body: unknown) =>
    SELF.fetch("https://example.com" + url, { method: "POST", headers: h, body: JSON.stringify(body) });

  it("wrong word enters book; 2 consecutive corrects graduate it; re-wrong re-enters", async () => {
    const wid = await seedWord("mb_word", "册甲");
    const inBook = async () => {
      const res = await SELF.fetch("https://example.com/api/session/mistakes?user_id=1");
      return (await json(res) as any[]).some((w) => w.term === "mb_word");
    };
    expect(await inBook()).toBe(false); // 全新词不在册
    await post("/api/review", { user_id: 1, word_id: wid, correct: false });
    expect(await inBook()).toBe(true);  // 错一次进本
    await post("/api/review", { user_id: 1, word_id: wid, correct: true });
    expect(await inBook()).toBe(true);  // 只对一次仍在册
    await post("/api/review", { user_id: 1, word_id: wid, correct: true });
    expect(await inBook()).toBe(false); // 连对 2 次毕业
    await post("/api/review", { user_id: 1, word_id: wid, correct: false });
    expect(await inBook()).toBe(true);  // 毕业后再错重新进本
  });

  it("home mistake_count tracks book size", async () => {
    const wid = await seedWord("mb_count", "册乙");
    const home = async () =>
      (await json(await SELF.fetch("https://example.com/api/home?user_id=1")) as any).mistake_count;
    const before = await home();
    await post("/api/review", { user_id: 1, word_id: wid, correct: false });
    expect(await home()).toBe(before + 1);
    await post("/api/review", { user_id: 1, word_id: wid, correct: true });
    await post("/api/review", { user_id: 1, word_id: wid, correct: true });
    expect(await home()).toBe(before); // 毕业, 计数回落
  });

  it("empty book returns []; missing user_id => 400", async () => {
    const res = await SELF.fetch("https://example.com/api/session/mistakes?user_id=910");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual([]);
    const bad = await SELF.fetch("https://example.com/api/session/mistakes");
    expect(bad.status).toBe(400);
  });
});

describe("admin: wrong_answer_events cascade cleanup", () => {
  beforeAll(async () => { await applySchema(); });
  const h = { "content-type": "application/json" };

  async function seedEvent(userId: number, wordId: number) {
    await env.DB.prepare(
      "INSERT INTO wrong_answer_events (user_id, word_id, answer, source, created_at) VALUES (?,?,?,NULL,1)"
    ).bind(userId, wordId, "x").run();
  }

  it("deleting a word removes its events too", async () => {
    const wid = await seedWord("cascade_evt", "级事");
    await seedEvent(1, wid);
    const res = await SELF.fetch(`https://example.com/api/admin/words/${wid}`, {
      method: "DELETE", headers: { "x-admin-token": adminToken },
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT id FROM wrong_answer_events WHERE word_id=?").bind(wid).first();
    expect(row).toBeNull();
  });

  it("deep unit-scoped reset deletes events in scope and reports events_deleted", async () => {
    const ua = await env.DB.prepare("INSERT INTO units (book, unit) VALUES ('级联书','CU1') RETURNING id").first<{ id: number }>();
    const ub = await env.DB.prepare("INSERT INTO units (book, unit) VALUES ('级联书','CU2') RETURNING id").first<{ id: number }>();
    const w1 = await seedWord("cascade_u1", "级甲");
    const w2 = await seedWord("cascade_u2", "级乙");
    await env.DB.prepare("INSERT INTO unit_words (unit_id, word_id) VALUES (?,?),(?,?)").bind(ua!.id, w1, ub!.id, w2).run();
    await seedEvent(920, w1);
    await seedEvent(920, w2);

    const res = await SELF.fetch("https://example.com/api/admin/reset-progress", {
      method: "POST", headers: { ...h, "x-admin-token": adminToken },
      body: JSON.stringify({ scope: "unit", unit_id: ua!.id, user_ids: [920], deep: true }),
    });
    const data: any = await json(res);
    expect(res.status).toBe(200);
    expect(data.events_deleted).toBe(1);
    const left = await env.DB.prepare(
      "SELECT word_id FROM wrong_answer_events WHERE user_id=920"
    ).all<{ word_id: number }>();
    expect(left.results.map((r) => r.word_id)).toEqual([w2]); // 范围外保留
  });
});

describe("kid: SRS state updates are atomic (B1 concurrency)", () => {
  beforeAll(async () => { await applySchema(); });

  it("concurrent correct reviews never lose SRS updates (B1)", async () => {
    const wid = await seedWord("raceword", "竞速");
    const starsBefore = (await env.DB.prepare(
      "SELECT stars FROM user_stats WHERE user_id=2"
    ).first<{ stars: number }>())?.stars ?? 0;

    const responses = await Promise.all(Array.from({ length: 6 }, () =>
      SELF.fetch("https://example.com/api/review", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_id: 2, word_id: wid, correct: true }),
      })));
    expect(responses.every((r) => r.status === 200)).toBe(true);

    const row = await env.DB.prepare(
      "SELECT reps FROM user_word_state WHERE user_id=2 AND word_id=?"
    ).bind(wid).first<{ reps: number }>();
    expect(row?.reps).toBe(6); // 修复前并发下 reps < 6 而 stars = +6

    const starsAfter = (await env.DB.prepare(
      "SELECT stars FROM user_stats WHERE user_id=2"
    ).first<{ stars: number }>())?.stars ?? 0;
    expect(starsAfter - starsBefore).toBe(6);
  });
});
