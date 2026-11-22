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

// —— 任务 7 新世界夹具（教材/共享池/卡片；id 用 8xx 段、sense 用 t7- 前缀防撞）——

async function seedKid(id: number, name: string) {
  await env.DB.prepare("INSERT INTO users (id, name, avatar) VALUES (?,?,'🧪')").bind(id, name).run();
}

async function seedCurriculumUnit(id: number, bookOrder: number, unit: number, book?: string, title?: string) {
  await env.DB.prepare("INSERT INTO curriculum_units VALUES (?,?,?,?,?)")
    .bind(id, book ?? `册${id}`, title ?? `测试第${id}册`, bookOrder, unit).run();
}

async function seedSenseT7(senseId: string, term: string, meaning: string, accepted: string[] = [term]) {
  await env.DB.prepare("INSERT INTO curriculum_senses VALUES (?,?,?,?)")
    .bind(senseId, term, meaning, JSON.stringify(accepted)).run();
}

async function linkSenseT7(unitId: number, senseId: string, rowOrder: number) {
  await env.DB.prepare("INSERT INTO curriculum_unit_senses VALUES (?,?,?)").bind(unitId, senseId, rowOrder).run();
}

async function openUnitT7(unitId: number) {
  await env.DB.prepare("INSERT INTO pool_units VALUES (?)").bind(unitId).run();
}

async function seedUserCardT7(userId: number, senseId: string, dueAt: number) {
  await env.DB.prepare("INSERT INTO user_cards (user_id, sense_id, due_at, card_json) VALUES (?,?,?,'{}')")
    .bind(userId, senseId, dueAt).run();
}

// 注意：vitest-pool-workers 默认 isolatedStorage=true，同一文件内**按用例回滚**：
// beforeAll（applySchema）的表结构与种子用户对每个用例可见，但前面用例 body 里
// 插入的行不可见。因此每个用例必须自带全部夹具（用户/单元/词义/卡），
// 也不存在"后面用例被前面用例入池的新词污染"的问题。

describe("kid: home（新世界契约：daily 卡片 + 错词数 + 开放单元）", () => {
  beforeAll(async () => { await applySchema(); });

  it("返回 stars/streak_days/mistakeCount/daily/units；units 只含共享池单元；未生成清单时 daily 为 null（不提前锁定）", async () => {
    const u = 540;
    await seedKid(u, "首页甲");
    await seedCurriculumUnit(801, 1, 1);
    await seedSenseT7("t7-home-a@1", "homea", "首页词甲");
    await seedSenseT7("t7-home-b@1", "homeb", "首页词乙");
    await linkSenseT7(801, "t7-home-a@1", 1);
    await linkSenseT7(801, "t7-home-b@1", 2);
    await openUnitT7(801);
    // 池外单元：不得出现在首页
    await seedCurriculumUnit(802, 2, 1);
    await seedSenseT7("t7-home-c@1", "homec", "池外词");
    await linkSenseT7(802, "t7-home-c@1", 1);

    const res = await SELF.fetch(`https://example.com/api/home?user_id=${u}`);
    const data = await json(res) as any;
    expect(res.status).toBe(200);
    expect(typeof data.stars).toBe("number");
    expect(typeof data.streak_days).toBe("number");
    expect(data.mistakeCount).toBe(0);
    expect(data.daily).toBeNull(); // 首页以已生成清单为准，预览不锁定当天清单
    expect(Array.isArray(data.units)).toBe(true);
    expect(data.units.map((x: any) => x.unitId)).toEqual([801]);
    expect(data.units[0]).toMatchObject({ book: `册801`, total: 2, covered: 0, pct: 0 });
  });

  it("daily 卡片随清单生成与作答推进：done/total 为权威进度", async () => {
    const u = 541;
    await seedKid(u, "首页乙");
    await seedCurriculumUnit(803, 3, 1);
    await seedSenseT7("t7-home-d@1", "homed", "进度词甲", ["homed"]);
    await seedSenseT7("t7-home-e@1", "homee", "进度词乙", ["homee"]);
    await linkSenseT7(803, "t7-home-d@1", 1);
    await linkSenseT7(803, "t7-home-e@1", 2);
    await openUnitT7(803);

    const opened = await json(await SELF.fetch("https://example.com/api/daily/open", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: u }),
    })) as any;
    expect(opened.items).toHaveLength(2);

    let home = await json(await SELF.fetch(`https://example.com/api/home?user_id=${u}`)) as any;
    expect(home.daily).toMatchObject({ day: opened.day, limit: opened.limit, done: 0, total: 2 });

    // 答对第一条 → done 权威 +1
    const ans = await SELF.fetch("https://example.com/api/daily/answer", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: u, itemId: opened.items[0].id, eventId: "t7-home-evt-1", action: "spell", answer: "homed" }),
    });
    expect(ans.status).toBe(200);
    expect(((await json(ans)) as any).item.status).toBe("done");

    home = await json(await SELF.fetch(`https://example.com/api/home?user_id=${u}`)) as any;
    expect(home.daily.done).toBe(1);
    expect(home.daily.total).toBe(2);
  });

  it("mistakeCount 由每日答错派生；订正完成后仍保留当天首次失败", async () => {
    const u = 542;
    await seedKid(u, "首页丙");
    await seedCurriculumUnit(804, 4, 1);
    await seedSenseT7("t7-home-f@1", "homef", "错词本词", ["homef"]);
    await linkSenseT7(804, "t7-home-f@1", 1);
    await openUnitT7(804);
    const opened = await json(await SELF.fetch("https://example.com/api/daily/open", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: u }),
    })) as any;
    const itemId = opened.items[0].id;
    const answer = (eventId: string, act: string, word: string) =>
      SELF.fetch("https://example.com/api/daily/answer", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: u, itemId, eventId, action: act, answer: word }),
      });

    const home0 = await json(await SELF.fetch(`https://example.com/api/home?user_id=${u}`)) as any;
    expect(home0.mistakeCount).toBe(0);

    expect((await answer("t7-home-evt-2", "spell", "wrong")).status).toBe(200);
    let home = await json(await SELF.fetch(`https://example.com/api/home?user_id=${u}`)) as any;
    expect(home.mistakeCount).toBe(1);

    // 订正答对：错词本保留（当天首次失败不清除）
    expect((await answer("t7-home-evt-3", "spell", "homef")).status).toBe(200);
    home = await json(await SELF.fetch(`https://example.com/api/home?user_id=${u}`)) as any;
    expect(home.mistakeCount).toBe(1);
    expect(home.daily.done).toBe(1);
  });

  it("units covered 按本人 user_cards 计：两人共用单元，进度互不影响", async () => {
    const u1 = 543, u2 = 544;
    await seedKid(u1, "兄弟甲7");
    await seedKid(u2, "兄弟乙7");
    await seedCurriculumUnit(805, 5, 1);
    await seedSenseT7("t7-home-g@1", "homeg", "共享词甲");
    await seedSenseT7("t7-home-h@1", "homeh", "共享词乙");
    await linkSenseT7(805, "t7-home-g@1", 1);
    await linkSenseT7(805, "t7-home-h@1", 2);
    await openUnitT7(805);
    await seedUserCardT7(u1, "t7-home-g@1", Date.now() + 86_400_000);

    const h1 = await json(await SELF.fetch(`https://example.com/api/home?user_id=${u1}`)) as any;
    const h2 = await json(await SELF.fetch(`https://example.com/api/home?user_id=${u2}`)) as any;
    const unit805a = h1.units.find((x: any) => x.unitId === 805);
    const unit805b = h2.units.find((x: any) => x.unitId === 805);
    expect(unit805a).toMatchObject({ total: 2, covered: 1, pct: 50 });
    expect(unit805b).toMatchObject({ total: 2, covered: 0, pct: 0 });
  });

  it("GET /api/home with missing user_id => 400", async () => {
    const res = await SELF.fetch("https://example.com/api/home");
    expect(res.status).toBe(400);
  });
});

// ---------- 单元练习数据源：开放单元词表 ----------

describe("kid: 单元词表 GET /api/unit-words（开放单元，含 accepted）", () => {
  beforeAll(async () => { await applySchema(); });

  it("开放单元按 row_order 返回 {senseId, term, meaning, accepted}", async () => {
    const u = 545;
    await seedKid(u, "词表甲");
    await seedCurriculumUnit(806, 6, 1);
    await seedSenseT7("t7-uw-b@1", "betaword", "词表乙", ["betaword", "beta"]);
    await seedSenseT7("t7-uw-a@1", "alphaword", "词表甲");
    await linkSenseT7(806, "t7-uw-b@1", 2);
    await linkSenseT7(806, "t7-uw-a@1", 1);
    await openUnitT7(806);

    const res = await SELF.fetch("https://example.com/api/unit-words?unit_id=806");
    const data = await json(res) as any[];
    expect(res.status).toBe(200);
    expect(data).toEqual([
      { senseId: "t7-uw-a@1", term: "alphaword", meaning: "词表甲", accepted: ["alphaword"] },
      { senseId: "t7-uw-b@1", term: "betaword", meaning: "词表乙", accepted: ["betaword", "beta"] },
    ]);
  });

  it("未开放（不在共享池）单元 404；未知单元 404；缺 unit_id 400", async () => {
    await seedCurriculumUnit(807, 7, 1);
    await seedSenseT7("t7-uw-c@1", "closedword", "池外词表词");
    await linkSenseT7(807, "t7-uw-c@1", 1);
    // 807 存在但未入池
    const closed = await SELF.fetch("https://example.com/api/unit-words?unit_id=807");
    expect(closed.status).toBe(404);
    const unknown = await SELF.fetch("https://example.com/api/unit-words?unit_id=987654");
    expect(unknown.status).toBe(404);
    const bad = await SELF.fetch("https://example.com/api/unit-words");
    expect(bad.status).toBe(400);
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
    // 只断言两个真实孩子在列且字段齐全（隔离存储下 progress 用户即 beforeAll 种子的 1/2）
    const ids = data.map((u: any) => u.id);
    expect(ids).toContain(1);
    expect(ids).toContain(2);
    expect(data.every((u: any) => "stars" in u && "mastered" in u)).toBe(true);
  });

  it("GET /api/admin/progress：mastered = user_cards 行数（新世界口径：学过的词）", async () => {
    const u = 551;
    await seedKid(u, "掌握口径");
    await seedSenseT7("t7-master-a@1", "mastera", "掌握词甲");
    await seedSenseT7("t7-master-b@1", "masterb", "掌握词乙");
    await seedUserCardT7(u, "t7-master-a@1", Date.now() + 86_400_000);
    await seedUserCardT7(u, "t7-master-b@1", Date.now() + 2 * 86_400_000);

    const res = await SELF.fetch("https://example.com/api/admin/progress", {
      headers: { "x-admin-token": adminToken },
    });
    const data: any = await json(res);
    const mine = data.find((x: any) => x.id === u);
    expect(mine.mastered).toBe(2); // 两张卡片 = 学过两个词
    expect(data.every((x: any) => typeof x.mastered === "number")).toBe(true);
  });
});

describe("admin: word delete cascades to avoid orphan inflation", () => {
  beforeAll(async () => { await applySchema(); });

  it("deleting a word removes its unit_links + state + events", async () => {
    const u = await env.DB.prepare(
      "INSERT INTO units (book, unit) VALUES ('书D','U1') RETURNING id"
    ).first<{ id: number }>();
    const wid = await seedWord("delcascade", "删词");
    await env.DB.prepare("INSERT INTO unit_words (unit_id, word_id) VALUES (?,?)").bind(u!.id, wid).run();
    await env.DB.prepare(
      "INSERT INTO user_word_state (user_id, word_id, reps, interval_days, due_at, lapses) VALUES (1,?,1,1,0,0)"
    ).bind(wid).run();
    await env.DB.prepare(
      "INSERT INTO wrong_answer_events (user_id, word_id, answer, source, created_at) VALUES (1,?,'oops',NULL,1)"
    ).bind(wid).run();

    const res = await SELF.fetch(`https://example.com/api/admin/words/${wid}`, {
      method: "DELETE", headers: { "x-admin-token": adminToken },
    });
    expect(res.status).toBe(200);

    expect(await env.DB.prepare("SELECT word_id FROM unit_words WHERE word_id=?").bind(wid).first()).toBeNull();
    expect(await env.DB.prepare("SELECT word_id FROM user_word_state WHERE word_id=?").bind(wid).first()).toBeNull();
    expect(await env.DB.prepare("SELECT word_id FROM wrong_answer_events WHERE word_id=?").bind(wid).first()).toBeNull();
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

  it("deep+global 同时清新世界表（user_cards/daily_lists→级联 daily_items/answer_events）；另一孩子与共享池/教材/配额原样", async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, name, avatar) VALUES (909,'重置新世甲','🧪'),(910,'重置新世乙','🧪')"
    ).run();
    // 教材/共享池夹具（独立 id 段，不与任务 7 夹具相撞）
    await env.DB.prepare(
      "INSERT INTO curriculum_units (id, book, book_title, book_order, unit) VALUES (951,'重置册','换库重置册',40,1)"
    ).run();
    await env.DB.prepare(
      "INSERT INTO curriculum_senses (sense_id, term, meaning, accepted_json) VALUES " +
        "('s-rst-a@1','reseta','重置词甲','[\"reseta\"]'),('s-rst-b@1','resetb','重置词乙','[\"resetb\"]')"
    ).run();
    await env.DB.prepare("INSERT INTO curriculum_unit_senses VALUES (951,'s-rst-a@1',1),(951,'s-rst-b@1',2)").run();
    await env.DB.prepare("INSERT INTO pool_units VALUES (951)").run();
    await env.DB.prepare("INSERT INTO user_quotas (user_id, daily_limit) VALUES (909,15),(910,20)").run();

    // 两个孩子各一套新世界进度：FSRS 卡、当日清单+条目、每日作答事件；孩子 1 另有加练事件（item_id NULL）
    const l1 = await env.DB.prepare(
      "INSERT INTO daily_lists (user_id, study_date, daily_limit, generation_token) VALUES (909,'2026-11-23',15,'tok-rst-1') RETURNING id"
    ).first<{ id: number }>();
    const i1 = await env.DB.prepare(
      "INSERT INTO daily_items (list_id, sense_id, position, kind, status, first_event_id) VALUES (?,'s-rst-a@1',0,'new','done','evt-rst-1') RETURNING id"
    ).bind(l1!.id).first<{ id: number }>();
    await env.DB.prepare("INSERT INTO user_cards VALUES (909,'s-rst-a@1',123,'{}')").run();
    await env.DB.prepare(
      "INSERT INTO answer_events (event_id,user_id,sense_id,item_id,source,action,answer,correct,created_at,rating) VALUES ('evt-rst-1',909,'s-rst-a@1',?,'daily','spell','reseta',1,1,'Good')"
    ).bind(i1!.id).run();
    await env.DB.prepare(
      "INSERT INTO answer_events (event_id,user_id,sense_id,item_id,source,action,answer,correct,created_at) VALUES ('evt-rst-p1',909,'s-rst-b@1',NULL,'mistake','spell','oops',0,1)"
    ).run();
    await env.DB.prepare("INSERT INTO user_word_state (user_id, word_id, reps) VALUES (909, 1, 4)").run();
    await env.DB.prepare("INSERT INTO user_stats (user_id, stars, streak_days, last_play_date) VALUES (909, 8, 2, '2026-11-23')").run();

    const l2 = await env.DB.prepare(
      "INSERT INTO daily_lists (user_id, study_date, daily_limit, generation_token) VALUES (910,'2026-11-23',20,'tok-rst-2') RETURNING id"
    ).first<{ id: number }>();
    const i2 = await env.DB.prepare(
      "INSERT INTO daily_items (list_id, sense_id, position, kind) VALUES (?,'s-rst-b@1',0,'new') RETURNING id"
    ).bind(l2!.id).first<{ id: number }>();
    await env.DB.prepare("INSERT INTO user_cards VALUES (910,'s-rst-b@1',456,'{}')").run();
    await env.DB.prepare(
      "INSERT INTO answer_events (event_id,user_id,sense_id,item_id,source,action,answer,correct,created_at,rating) VALUES ('evt-rst-2',910,'s-rst-b@1',?,'daily','spell','resetb',1,1,'Good')"
    ).bind(i2!.id).run();

    // 重置前的共享面快照：共享池/教材/配额/账号不得被用户级重置触碰（计划原文约束）
    const sharedCount = async (t: string) =>
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())?.n ?? -1;
    const sharedTables = ["pool_units","curriculum_units","curriculum_senses","curriculum_unit_senses","user_quotas","users"];
    const sharedBefore: Array<[string, number]> = [];
    for (const t of sharedTables) sharedBefore.push([t, await sharedCount(t)]);

    const res = await SELF.fetch("https://example.com/api/admin/reset-progress", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ scope: "global", user_ids: [909], deep: true }),
    });
    expect(res.status).toBe(200);

    // 孩子 1：新世界四类全空。daily_items 随 daily_lists ON DELETE CASCADE 带走；
    // answer_events 中挂条目的每日事件随条目级联删除，加练事件（item_id NULL）由显式 DELETE 兜住。
    for (const [t, where, arg] of [
      ["user_cards", "user_id", 909],
      ["daily_lists", "user_id", 909],
      ["answer_events", "user_id", 909],
    ] as const) {
      expect(
        await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${where}=?`).bind(arg).first<{ n: number }>(),
        `${t} 深度重置后应为空`,
      ).toEqual({ n: 0 });
    }
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM daily_items WHERE list_id=?").bind(l1!.id).first<{ n: number }>(),
      "daily_items 应随清单级联删除",
    ).toEqual({ n: 0 });
    // 旧世界口径仍清：user_word_state 行消失、stats 归零
    expect(await env.DB.prepare("SELECT word_id FROM user_word_state WHERE user_id=909").first()).toBeNull();
    expect(await env.DB.prepare("SELECT stars, streak_days FROM user_stats WHERE user_id=909").first<any>())
      .toEqual({ stars: 0, streak_days: 0 });

    // 孩子 2：逐表原样
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM user_cards WHERE user_id=910").first<{ n: number }>()).toEqual({ n: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM daily_lists WHERE user_id=910").first<{ n: number }>()).toEqual({ n: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM daily_items WHERE list_id=?").bind(l2!.id).first<{ n: number }>()).toEqual({ n: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM answer_events WHERE user_id=910").first<{ n: number }>()).toEqual({ n: 1 });

    // 共享池/教材/配额/账号：计数不变
    for (const [t, before] of sharedBefore) {
      expect(await sharedCount(t), `${t} 不得被用户级重置触碰`).toBe(before);
    }
    expect(await env.DB.prepare("SELECT daily_limit FROM user_quotas WHERE user_id=910").first<{ daily_limit: number }>())
      .toEqual({ daily_limit: 20 });
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

describe("kid: 错词本 GET /api/mistakes（answer_events 每日答错派生）", () => {
  beforeAll(async () => { await applySchema(); });

  async function seedWrongEvent(eventId: string, userId: number, senseId: string, createdAt: number, source = "daily") {
    await env.DB.prepare(
      `INSERT INTO answer_events (event_id, user_id, sense_id, item_id, source, action, answer, correct, created_at)
       VALUES (?,?,?,NULL,?,'spell','oops',0,?)`
    ).bind(eventId, userId, senseId, source, createdAt).run();
  }

  it("空词本返回 []；缺 user_id 400；未知用户 404", async () => {
    const u = 546;
    await seedKid(u, "词本空");
    const res = await SELF.fetch(`https://example.com/api/mistakes?user_id=${u}`);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual([]);
    const bad = await SELF.fetch("https://example.com/api/mistakes");
    expect(bad.status).toBe(400);
    const ghost = await SELF.fetch("https://example.com/api/mistakes?user_id=424242");
    expect(ghost.status).toBe(404);
  });

  it("只派生每日作答（source='daily'）的答错记录；加练（unit/mistake）不入本", async () => {
    const u = 547;
    await seedKid(u, "词本派生");
    await seedSenseT7("t7-mb-daily@1", "dailywrong", "每日答错词", ["dailywrong"]);
    await seedSenseT7("t7-mb-unit@1", "unitwrong", "加练答错词", ["unitwrong"]);
    await seedWrongEvent("t7-mb-evt-1", u, "t7-mb-daily@1", Date.now());
    await seedWrongEvent("t7-mb-evt-2", u, "t7-mb-unit@1", Date.now(), "unit");
    await seedWrongEvent("t7-mb-evt-3", u, "t7-mb-unit@1", Date.now(), "mistake");
    const data = await json(await SELF.fetch(`https://example.com/api/mistakes?user_id=${u}`)) as any[];
    expect(data.map((x) => x.senseId)).toEqual(["t7-mb-daily@1"]);
    expect(data[0]).toMatchObject({ term: "dailywrong", meaning: "每日答错词" });
    expect(typeof data[0].lastWrongAt).toBe("number");
  });

  it("同 sense 多次答错去重，lastWrongAt 取最近一次", async () => {
    const u = 548;
    await seedKid(u, "词本去重");
    await seedSenseT7("t7-mb-dup@1", "dupwrong", "重复答错词", ["dupwrong"]);
    const t1 = 1_700_000_000_000;
    const t2 = 1_700_000_100_000;
    await seedWrongEvent("t7-mb-evt-4", u, "t7-mb-dup@1", t1);
    await seedWrongEvent("t7-mb-evt-5", u, "t7-mb-dup@1", t2);
    const data = await json(await SELF.fetch(`https://example.com/api/mistakes?user_id=${u}`)) as any[];
    expect(data).toHaveLength(1);
    expect(data[0].lastWrongAt).toBe(t2);
  });

  it("返回 accepted 数组供自主加练判定；他人答错不进我的词本", async () => {
    const me = 549, other = 550;
    await seedKid(me, "词本甲");
    await seedKid(other, "词本乙");
    await seedSenseT7("t7-mb-alias@1", "aliasword", "别名错词", ["aliasword", "alias"]);
    await seedWrongEvent("t7-mb-evt-6", me, "t7-mb-alias@1", Date.now());
    await seedWrongEvent("t7-mb-evt-7", other, "t7-mb-alias@1", Date.now());
    const data = await json(await SELF.fetch(`https://example.com/api/mistakes?user_id=${me}`)) as any[];
    expect(data).toHaveLength(1);
    expect(data[0].accepted).toEqual(["aliasword", "alias"]);
  });
});

describe("kid: 每日流程 API 回归（open → answer → status 权威；加练不越界）", () => {
  beforeAll(async () => { await applySchema(); });

  const openDaily = (userId: number) =>
    SELF.fetch("https://example.com/api/daily/open", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId }),
    });

  async function setupDaily(u: number, unitId: number, senses: [string, string, string][]) {
    await seedKid(u, `流程${u}`);
    await seedCurriculumUnit(unitId, unitId % 100, 1);
    for (let i = 0; i < senses.length; i++) {
      const [sid, term, meaning] = senses[i];
      await seedSenseT7(sid, term, meaning);
      await linkSenseT7(unitId, sid, i + 1);
    }
    await openUnitT7(unitId);
    const opened = await json(await openDaily(u)) as any;
    expect(opened.items).toHaveLength(senses.length);
    return opened as { day: string; limit: number; items: { id: number; senseId: string; status: string }[] };
  }

  const postAnswer = (body: Record<string, unknown>) =>
    SELF.fetch("https://example.com/api/daily/answer", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("open → spell 对 → 再 open：同一份清单（同条目 ID），该条 status='done'（服务端权威）", async () => {
    const opened = await setupDaily(560, 820, [
      ["t7-flow-a@1", "flowa", "流程词甲"],
      ["t7-flow-b@1", "flowb", "流程词乙"],
    ]);
    const itemId = opened.items[0].id;
    const ans = await postAnswer({ userId: 560, itemId, eventId: "t7-flow-evt-1", action: "spell", answer: "flowa" });
    expect(ans.status).toBe(200);
    const verdict = await json(ans) as any;
    expect(verdict.applied).toBe(true);
    expect(verdict.item.status).toBe("done");

    const reopened = await json(await openDaily(560)) as any;
    expect(reopened.day).toBe(opened.day);
    expect(reopened.items.map((i: any) => i.id)).toEqual(opened.items.map((i: any) => i.id));
    expect(reopened.items.find((i: any) => i.id === itemId).status).toBe("done");
    expect(reopened.items.find((i: any) => i.id === opened.items[1].id).status).toBe("pending");
  });

  it("spell 错 → status='correction' → 订正对 → 'done'；首次评级恰好一条", async () => {
    const opened = await setupDaily(561, 821, [["t7-flow-c@1", "flowc", "订正词"]]);
    const itemId = opened.items[0].id;
    const wrong = await json(await postAnswer({ userId: 561, itemId, eventId: "t7-flow-evt-2", action: "spell", answer: "nope" })) as any;
    expect(wrong.item.status).toBe("correction");
    expect(wrong.rating).toBe("Again");

    const fix = await json(await postAnswer({ userId: 561, itemId, eventId: "t7-flow-evt-3", action: "spell", answer: "flowc" })) as any;
    expect(fix.item.status).toBe("done");
    expect(fix.rating).toBeNull(); // 订正不评级
    expect(fix.starsAwarded).toBe(0);

    const evs = await env.DB.prepare(
      "SELECT rating FROM answer_events WHERE item_id=?"
    ).bind(itemId).all<{ rating: string | null }>();
    expect(evs.results.filter((e) => e.rating !== null)).toHaveLength(1);
  });

  it("加练（/api/review sense 路径）不完成每日条目、不改 due、不写 user_cards、不写每日评级", async () => {
    const opened = await setupDaily(562, 822, [["t7-flow-d@1", "flowd", "加练边界词"]]);
    const itemId = opened.items[0].id;
    // 先完成每日条目，建立 user_card
    expect((await postAnswer({ userId: 562, itemId, eventId: "t7-flow-evt-4", action: "spell", answer: "flowd" })).status).toBe(200);
    const cardBefore = await env.DB.prepare(
      "SELECT due_at, card_json FROM user_cards WHERE user_id=562 AND sense_id='t7-flow-d@1'"
    ).first<{ due_at: number; card_json: string }>();
    expect(cardBefore).not.toBeNull();

    // 同一 sense 自主加练：答错再答对，均走 /review
    const p1 = await SELF.fetch("https://example.com/api/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: 562, senseId: "t7-flow-d@1", eventId: "t7-flow-prac-1", correct: false, source: "unit", answer: "oops" }),
    });
    expect(p1.status).toBe(200);
    const p2 = await SELF.fetch("https://example.com/api/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: 562, senseId: "t7-flow-d@1", eventId: "t7-flow-prac-2", correct: true, source: "unit" }),
    });
    expect(p2.status).toBe(200);

    // 每日条目不受影响：仍 done、首次事件不变
    const reopened = await json(await openDaily(562)) as any;
    expect(reopened.items[0].status).toBe("done");
    const cardAfter = await env.DB.prepare(
      "SELECT due_at, card_json FROM user_cards WHERE user_id=562 AND sense_id='t7-flow-d@1'"
    ).first<{ due_at: number; card_json: string }>();
    expect(cardAfter).toEqual(cardBefore); // 加练不改 due（FSRS 只由每日作答推进）

    // 加练事件不产生每日评级，且不入错词本
    const rated = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM answer_events WHERE sense_id='t7-flow-d@1' AND rating IS NOT NULL"
    ).first<{ n: number }>();
    expect(rated?.n).toBe(1); // 只有每日首次作答那一条 Good
    const mistakes = await json(await SELF.fetch("https://example.com/api/mistakes?user_id=562")) as any[];
    expect(mistakes).toEqual([]); // 加练答错（source=unit）不进错词本
  });
});

describe("kid: /api/review sense 加练路径（练习日志）", () => {
  beforeAll(async () => { await applySchema(); });

  const practice = (body: Record<string, unknown>) =>
    SELF.fetch("https://example.com/api/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("答对加练：写 answer_events(source/rating NULL)、发星星、不写 user_cards/user_word_state/wrong_answer_events", async () => {
    const u = 563;
    await seedKid(u, "加练对");
    await seedSenseT7("t7-pr-a@1", "practica", "加练词甲", ["practica"]);
    const res = await practice({ userId: u, senseId: "t7-pr-a@1", eventId: "t7-pr-evt-1", correct: true, source: "unit" });
    const data = await json(res) as any;
    expect(res.status).toBe(200);
    expect(data).toMatchObject({ eventId: "t7-pr-evt-1", applied: true, correct: true, starsAwarded: 1 });
    expect(data.stars).toBe(1);

    const ev = await env.DB.prepare(
      "SELECT source, action, rating, card_before_json, card_after_json, item_id, correct FROM answer_events WHERE event_id='t7-pr-evt-1'"
    ).first<any>();
    expect(ev).toMatchObject({ source: "unit", action: "spell", rating: null, card_before_json: null, card_after_json: null, item_id: null, correct: 1 });
    expect(await env.DB.prepare("SELECT sense_id FROM user_cards WHERE user_id=?").bind(u).first()).toBeNull();
    expect(await env.DB.prepare("SELECT word_id FROM user_word_state WHERE user_id=?").bind(u).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM wrong_answer_events WHERE user_id=?").bind(u).first()).toBeNull();
  });

  it("答错加练：answer 归一存储（trim+小写，截断 100）；source 必须为 unit/mistake", async () => {
    const u = 564;
    await seedKid(u, "加练错");
    await seedSenseT7("t7-pr-b@1", "practicb", "加练词乙", ["practicb"]);
    const long = "b".repeat(150);
    const res = await practice({ userId: u, senseId: "t7-pr-b@1", eventId: "t7-pr-evt-2", correct: false, source: "mistake", answer: `  ${long}  ` });
    expect(res.status).toBe(200);
    const ev = await env.DB.prepare(
      "SELECT answer, source, rating FROM answer_events WHERE event_id='t7-pr-evt-2'"
    ).first<any>();
    expect((ev!.answer as string).length).toBe(100);
    expect(ev!.source).toBe("mistake");
    expect(ev!.rating).toBeNull();

    // source='daily' 由每日流程独占：加练通道不得伪造每日作答
    const forged = await practice({ userId: u, senseId: "t7-pr-b@1", eventId: "t7-pr-evt-3", correct: true, source: "daily" });
    expect(forged.status).toBe(400);
    const other = await practice({ userId: u, senseId: "t7-pr-b@1", eventId: "t7-pr-evt-4", correct: true, source: "cheat" });
    expect(other.status).toBe(400);
  });

  it("同 eventId 重发返回原结果且不重复计分；跨用户 eventId 冲突 409 且零写入", async () => {
    const a = 565, b = 566;
    await seedKid(a, "加练幂甲");
    await seedKid(b, "加练幂乙");
    await seedSenseT7("t7-pr-c@1", "practicc", "加练词丙", ["practicc"]);
    await seedSenseT7("t7-pr-d@1", "practicd", "加练词丁", ["practicd"]);

    const first = await json(await practice({ userId: a, senseId: "t7-pr-c@1", eventId: "t7-pr-evt-shared", correct: true, source: "unit" })) as any;
    expect(first.applied).toBe(true);

    // 同用户同事件重发：原结果回放，无新增事件、无重复星星
    const replay = await json(await practice({ userId: a, senseId: "t7-pr-c@1", eventId: "t7-pr-evt-shared", correct: true, source: "unit" })) as any;
    expect(replay).toEqual(first);
    const starsA = await env.DB.prepare("SELECT stars FROM user_stats WHERE user_id=?").bind(a).first<{ stars: number }>();
    expect(starsA?.stars).toBe(1);
    const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM answer_events WHERE event_id='t7-pr-evt-shared'").first<{ n: number }>();
    expect(cnt?.n).toBe(1);

    // 跨用户碰撞（ eventId 全局 PK）：后到者 409 零写入
    const clash = await practice({ userId: b, senseId: "t7-pr-d@1", eventId: "t7-pr-evt-shared", correct: true, source: "mistake" });
    expect(clash.status).toBe(409);
    expect(await env.DB.prepare("SELECT sense_id FROM answer_events WHERE event_id='t7-pr-evt-shared'").first<{ sense_id: string }>())
      .toMatchObject({ sense_id: "t7-pr-c@1" });
    expect(await env.DB.prepare("SELECT event_id FROM answer_events WHERE user_id=?").bind(b).first()).toBeNull();
    expect(await env.DB.prepare("SELECT stars FROM user_stats WHERE user_id=?").bind(b).first()).toBeNull();
  });

  it("参数校验：缺字段/坏类型 400；未知 sense 或用户 404", async () => {
    const u = 567;
    await seedKid(u, "加练校验");
    await seedSenseT7("t7-pr-e@1", "practice", "加练词戊", ["practice"]);
    const base = { userId: u, senseId: "t7-pr-e@1", eventId: "t7-pr-evt-ok", correct: true, source: "unit" };
    const badBodies = [
      {},
      { ...base, userId: 0 },
      { ...base, userId: 1.5 },
      { ...base, senseId: "" },
      { ...base, senseId: 42 },
      { ...base, eventId: "" },
      { ...base, eventId: "x".repeat(101) },
      { ...base, correct: "true" },
      { ...base, source: 7 },
    ];
    for (const body of badBodies) {
      const res = await practice(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await practice({ ...base, senseId: "ghost@1" })).status).toBe(404);
    expect((await practice({ ...base, userId: 424242 })).status).toBe(404);
    // 校验路径零写入
    expect(await env.DB.prepare("SELECT event_id FROM answer_events WHERE user_id=?").bind(u).first()).toBeNull();
    // 本人正常提交仍可用
    const ok = await practice({ ...base, eventId: "t7-pr-evt-real" });
    expect(ok.status).toBe(200);
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

describe("json body guard (B5)", () => {
  beforeAll(async () => { await applySchema(); });
  const endpoints = [
    "/api/cover", "/api/admin/units",
    "/api/admin/import", "/api/admin/reset-progress",
  ];
  for (const ep of endpoints) {
    it(`POST ${ep} rejects malformed JSON with 400`, async () => {
      const res = await SELF.fetch("https://example.com" + ep, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": adminToken },
        body: "not-json",
      });
      expect(res.status).toBe(400);
    });
  }

  it("PUT /api/admin/words/:id rejects missing meaning_cn with 400", async () => {
    const wid = await seedWord("putguard", "守");
    const res = await SELF.fetch(`https://example.com/api/admin/words/${wid}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ pos: "n" }),
    });
    expect(res.status).toBe(400);
    // 原数据未被破坏
    const row = await env.DB.prepare("SELECT meaning_cn FROM words WHERE id=?").bind(wid).first();
    expect(row?.meaning_cn).toBe("守");
  });

  it("PUT /api/admin/words/:id returns 404 for nonexistent word (B10)", async () => {
    const res = await SELF.fetch("https://example.com/api/admin/words/424242", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ meaning_cn: "x", pos: null, example_en: null, example_cn: null }),
    });
    expect(res.status).toBe(404);
  });

  it("PUT /api/admin/words/:id rejects non-integer id with 400", async () => {
    const res = await SELF.fetch("https://example.com/api/admin/words/abc", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ meaning_cn: "x" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("admin units sort_key (B7/B8)", () => {
  beforeAll(async () => { await applySchema(); });
  it("re-creating an existing unit without sort_key keeps the old sort_key", async () => {
    const book = "排序书" + Date.now();
    await SELF.fetch("https://example.com/api/admin/units", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ book, unit: "U1", sort_key: 5 }),
    });
    const res = await SELF.fetch("https://example.com/api/admin/units", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ book, unit: "U1" }), // 不带 sort_key
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT sort_key FROM units WHERE book=? AND unit='U1'"
    ).bind(book).first<{ sort_key: number }>();
    expect(row?.sort_key).toBe(5); // 修复前被重置为 0
  });
  it("rejects non-integer sort_key with 400", async () => {
    const res = await SELF.fetch("https://example.com/api/admin/units", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ book: "类型书", unit: "U", sort_key: "abc" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("admin: import validates unit exists (B6)", () => {
  beforeAll(async () => { await applySchema(); });
  it("import to nonexistent unit returns 404 and writes nothing (B6)", async () => {
    const wordsBefore = (await env.DB.prepare("SELECT COUNT(*) n FROM words").first<{ n: number }>())!.n;
    const res = await SELF.fetch("https://example.com/api/admin/import", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ unit_id: 424242, csv: "ghostword,幽灵" }),
    });
    expect(res.status).toBe(404);
    const wordsAfter = (await env.DB.prepare("SELECT COUNT(*) n FROM words").first<{ n: number }>())!.n;
    expect(wordsAfter).toBe(wordsBefore);
  });

  it("import skips rows with unsupported term chars, imports valid rows (charset)", async () => {
    const u = (await env.DB.prepare(
      "INSERT INTO units (book, unit) VALUES ('字符集书','U1') RETURNING id"
    ).first<{ id: number }>())!;
    const res = await SELF.fetch("https://example.com/api/admin/import", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({
        unit_id: u.id,
        csv: "charsetok,好词\nbad(term),坏词\n",
      }),
    });
    const data: any = await json(res);
    expect(res.status).toBe(200);
    expect(data.inserted).toBe(1);
    expect(data.errors.length).toBe(1);
    expect(data.errors[0].line).toBe(2);
    expect(data.errors[0].message).toContain("(");
    const ok = await env.DB.prepare("SELECT term FROM words WHERE term='charsetok'").first();
    const bad = await env.DB.prepare("SELECT term FROM words WHERE term='bad(term)'").first();
    expect(ok).not.toBeNull();
    expect(bad).toBeNull();
  });
});

describe("api 404 fallback (B4)", () => {
  beforeAll(async () => { await applySchema(); });
  it("unknown /api path returns JSON 404, not SPA html", async () => {
    const res = await SELF.fetch("https://example.com/api/nonexistent");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await json(res)).toEqual({ error: "not_found" });
  });
  it("method mismatch returns JSON 404", async () => {
    const res = await SELF.fetch("https://example.com/api/review");
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "not_found" });
  });
  it("trailing slash does not fall through to SPA", async () => {
    const res = await SELF.fetch("https://example.com/api/users/");
    expect(res.status).toBe(404);
  });
});

describe("hardening (B9/B14a)", () => {
  beforeAll(async () => { await applySchema(); });
  it("GET /api/home returns 404 for unknown user", async () => {
    const res = await SELF.fetch("https://example.com/api/home?user_id=424242");
    expect(res.status).toBe(404);
  });
  it("admin auth still accepts correct token and rejects wrong one", async () => {
    const ok = await SELF.fetch("https://example.com/api/admin/units", { headers: { "x-admin-token": adminToken } });
    expect(ok.status).toBe(200);
    const bad = await SELF.fetch("https://example.com/api/admin/units", { headers: { "x-admin-token": "x".repeat(64) } });
    expect(bad.status).toBe(401);
  });
});

describe("review conflict-path interval pinning", () => {
  beforeAll(async () => { await applySchema(); });

  it("已存在状态的 correct 复习按 INTERVAL_CASE 阶梯返回 interval_days", async () => {
    // 钉住 kid.ts 里 INTERVAL_CASE 与 srs.ts 的一致性：
    // idx = max(0, min(reps+1, 7) - (lapses>0 ? 1 : 0)) 索引 INTERVALS_DAYS = [0,1,2,4,8,16,30,60]。
    // 期望值刻意硬编码：若有人改了 INTERVALS_DAYS/步退逻辑，本测试必须失败，
    // 逼其同步更新 kid.ts 的 SQL 阶梯，而不是让 SQL 悄悄偏离。
    const cases = [
      { term: "pinw1", reps: 2, lapses: 0, expected: 4 },
      { term: "pinw2", reps: 2, lapses: 1, expected: 2 },  // 步退一档
      { term: "pinw3", reps: 8, lapses: 0, expected: 60 }, // 封顶 7
      { term: "pinw4", reps: 8, lapses: 2, expected: 30 },
    ];
    for (const c of cases) {
      const wid = await seedWord(c.term);
      await env.DB.prepare(
        "INSERT OR REPLACE INTO user_word_state (user_id, word_id, reps, interval_days, due_at, lapses, last_reviewed_at) VALUES (?,?,?,?,?,?,?)"
      ).bind(1, wid, c.reps, 1, 1, c.lapses, 1).run();
      const nowBefore = Date.now();
      const res = await SELF.fetch("https://example.com/api/review", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_id: 1, word_id: wid, correct: true }),
      });
      const data: any = await json(res);
      expect(res.status).toBe(200);
      expect(data.state.reps).toBe(c.reps + 1);
      expect(data.state.interval_days).toBe(c.expected);
      if (c.term === "pinw1") {
        expect(data.state.due_at).toBeGreaterThan(nowBefore); // interval>0 => 未来到期
      }
    }
  });
});
