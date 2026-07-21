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

export { admin };
