import { Hono } from "hono";
import type { Env } from "./index";
import { adminAuth } from "./auth";
import { parseWordCsv } from "./csv";
import { MASTERY_REPS } from "./srs";

const admin = new Hono<{ Bindings: Env }>();
admin.use("*", adminAuth);

admin.get("/units", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, book, unit, sort_key FROM units ORDER BY sort_key, id"
  ).all();
  return c.json(results);
});

admin.post("/units", async (c) => {
  const body = await c.req.json<{ book: string; unit: string; sort_key?: number }>();
  if (!body.book || !body.unit) return c.json({ error: "缺少 book/unit" }, 400);
  const r = await c.env.DB.prepare(
    `INSERT INTO units (book, unit, sort_key) VALUES (?,?,?)
     ON CONFLICT(book, unit) DO UPDATE SET sort_key=excluded.sort_key
     RETURNING id`
  ).bind(body.book, body.unit, body.sort_key ?? 0).first<{ id: number }>();
  return c.json({ id: r?.id });
});

admin.post("/import", async (c) => {
  const body = await c.req.json<{ unit_id: number; csv: string }>();
  if (!body.unit_id || !body.csv) return c.json({ error: "缺少 unit_id/csv" }, 400);
  const { rows, errors } = parseWordCsv(body.csv);
  let inserted = 0, updated = 0, linked = 0;
  for (const row of rows) {
    const existing = await c.env.DB.prepare("SELECT id FROM words WHERE term=?")
      .bind(row.term).first<{ id: number }>();
    let wordId: number;
    if (existing) {
      await c.env.DB.prepare(
        "UPDATE words SET pos=?, meaning_cn=?, example_en=?, example_cn=? WHERE id=?"
      ).bind(row.pos, row.meaning_cn, row.example_en, row.example_cn, existing.id).run();
      wordId = existing.id;
      updated++;
    } else {
      const ins = await c.env.DB.prepare(
        "INSERT INTO words (term, pos, meaning_cn, example_en, example_cn, created_at) VALUES (?,?,?,?,?,?) RETURNING id"
      ).bind(row.term, row.pos, row.meaning_cn, row.example_en, row.example_cn, Date.now())
        .first<{ id: number }>();
      wordId = ins!.id;
      inserted++;
    }
    const link = await c.env.DB.prepare(
      "INSERT OR IGNORE INTO unit_words (unit_id, word_id) VALUES (?,?)"
    ).bind(body.unit_id, wordId).run();
    if (link.meta.changes) linked++;
  }
  return c.json({ inserted, updated, linked, errors });
});

admin.get("/progress", async (c) => {
  const { results: users } = await c.env.DB.prepare(
    "SELECT id, name, avatar FROM users ORDER BY id"
  ).all<{ id: number; name: string; avatar: string }>();
  const out = [];
  for (const u of users) {
    const st = await c.env.DB.prepare(
      "SELECT stars, streak_days FROM user_stats WHERE user_id=?"
    ).bind(u.id).first<{ stars: number; streak_days: number }>();
    const mastered = await c.env.DB.prepare(
      "SELECT COUNT(*) as n FROM user_word_state WHERE user_id=? AND reps>=?"
    ).bind(u.id, MASTERY_REPS).first<{ n: number }>();
    out.push({
      id: u.id, name: u.name, avatar: u.avatar,
      stars: st?.stars ?? 0, streak_days: st?.streak_days ?? 0,
      mastered: mastered?.n ?? 0,
    });
  }
  return c.json(out);
});

admin.post("/reset-progress", async (c) => {
  const body = await c.req.json<{ scope: string; unit_id?: number; book?: string; user_ids: number[]; deep?: boolean }>();
  const user_ids = body.user_ids;
  if (!Array.isArray(user_ids) || user_ids.length === 0 ||
      !user_ids.every((n) => Number.isInteger(n) && n > 0)) {
    return c.json({ error: "user_ids 不合法" }, 400);
  }
  const placeholders = user_ids.map(() => "?").join(",");
  const deep = body.deep === true;

  let coverageSql: string;
  let coverageArgs: unknown[];
  // 掌握度按范围限定：只删范围内单词的 user_word_state
  let stateWordFilter = "";
  let stateExtraArgs: unknown[] = [];
  if (body.scope === "unit") {
    if (!Number.isInteger(body.unit_id) || (body.unit_id as number) <= 0) return c.json({ error: "缺少 unit_id" }, 400);
    coverageSql = `DELETE FROM user_unit_word_seen WHERE user_id IN (${placeholders}) AND unit_id = ?`;
    coverageArgs = [...user_ids, body.unit_id];
    stateWordFilter = ` AND word_id IN (SELECT word_id FROM unit_words WHERE unit_id = ?)`;
    stateExtraArgs = [body.unit_id];
  } else if (body.scope === "book") {
    if (!body.book || !body.book.trim()) return c.json({ error: "缺少 book" }, 400);
    coverageSql = `DELETE FROM user_unit_word_seen WHERE user_id IN (${placeholders}) AND unit_id IN (SELECT id FROM units WHERE book = ?)`;
    coverageArgs = [...user_ids, body.book];
    stateWordFilter = ` AND word_id IN (SELECT word_id FROM unit_words WHERE unit_id IN (SELECT id FROM units WHERE book = ?))`;
    stateExtraArgs = [body.book];
  } else if (body.scope === "global") {
    coverageSql = `DELETE FROM user_unit_word_seen WHERE user_id IN (${placeholders})`;
    coverageArgs = [...user_ids];
  } else {
    return c.json({ error: "scope 不合法" }, 400);
  }

  const db = c.env.DB;
  const stmts = [db.prepare(coverageSql).bind(...coverageArgs)];
  if (deep) {
    stmts.push(db.prepare(
      `DELETE FROM user_word_state WHERE user_id IN (${placeholders})${stateWordFilter}`
    ).bind(...user_ids, ...stateExtraArgs));
    stmts.push(db.prepare(
      `DELETE FROM wrong_answer_events WHERE user_id IN (${placeholders})${stateWordFilter}`
    ).bind(...user_ids, ...stateExtraArgs));
    stmts.push(db.prepare(
      `UPDATE user_stats SET stars=0, streak_days=0, last_play_date=NULL WHERE user_id IN (${placeholders})`
    ).bind(...user_ids));
  }
  const results = await db.batch(stmts);
  return c.json({
    ok: true,
    deleted: results[0].meta.changes ?? 0,
    state_deleted: deep ? (results[1].meta.changes ?? 0) : 0,
    events_deleted: deep ? (results[2].meta.changes ?? 0) : 0,
    stats_reset: deep ? (results[3].meta.changes ?? 0) : 0,
  });
});

admin.get("/words", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, term, pos, meaning_cn, example_en, example_cn FROM words ORDER BY term"
  ).all();
  return c.json(results);
});

admin.put("/words/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ pos: string | null; meaning_cn: string; example_en: string | null; example_cn: string | null }>();
  await c.env.DB.prepare(
    "UPDATE words SET pos=?, meaning_cn=?, example_en=?, example_cn=? WHERE id=?"
  ).bind(body.pos ?? null, body.meaning_cn, body.example_en ?? null, body.example_cn ?? null, id).run();
  return c.json({ ok: true });
});

admin.delete("/words/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const db = c.env.DB;
  // Cascade so deleting a word doesn't leave orphans that would inflate unit
  // totals (home progress) or mastered counts.
  await db.batch([
    db.prepare("DELETE FROM user_unit_word_seen WHERE word_id=?").bind(id),
    db.prepare("DELETE FROM user_word_state WHERE word_id=?").bind(id),
    db.prepare("DELETE FROM unit_words WHERE word_id=?").bind(id),
    db.prepare("DELETE FROM wrong_answer_events WHERE word_id=?").bind(id),
    db.prepare("DELETE FROM words WHERE id=?").bind(id),
  ]);
  return c.json({ ok: true });
});

export { admin };
