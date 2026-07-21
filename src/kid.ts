import { Hono } from "hono";
import type { Env } from "./index";
import { updateSrs, emptyState, type SrsState } from "./srs";

const kid = new Hono<{ Bindings: Env }>();
const TIME_ZONE = "Asia/Shanghai";

function dayStr(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date(ms));
}

async function applyReviewStats(db: D1Database, userId: number, now: number, correct: boolean) {
  const today = dayStr(now);
  const row = await db.prepare(
    "SELECT stars, streak_days, last_play_date FROM user_stats WHERE user_id=?"
  ).bind(userId).first<{ stars: number; streak_days: number; last_play_date: string | null }>();
  let stars = row?.stars ?? 0;
  let streak = row?.streak_days ?? 0;
  const last = row?.last_play_date ?? null;
  if (last !== today) {
    const yesterday = dayStr(now - 86_400_000);
    streak = last === yesterday ? streak + 1 : 1;
  }
  if (correct) stars += 1;
  await db.prepare(
    `INSERT INTO user_stats (user_id, stars, streak_days, last_play_date) VALUES (?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET stars=excluded.stars, streak_days=excluded.streak_days, last_play_date=excluded.last_play_date`
  ).bind(userId, stars, streak, today).run();
  return { stars, streak_days: streak };
}

kid.get("/users", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, avatar FROM users ORDER BY id"
  ).all();
  return c.json(results);
});

kid.post("/review", async (c) => {
  const body = await c.req.json<{ user_id: number; word_id: number; correct: boolean }>();
  if (!body.user_id || !body.word_id) return c.json({ error: "参数不完整" }, 400);
  const now = Date.now();
  const prev = await c.env.DB.prepare(
    "SELECT reps, interval_days, due_at, lapses, last_reviewed_at FROM user_word_state WHERE user_id=? AND word_id=?"
  ).bind(body.user_id, body.word_id).first<SrsState>();
  const state = updateSrs(prev ?? emptyState(now), body.correct, now);
  await c.env.DB.prepare(
    `INSERT INTO user_word_state (user_id, word_id, reps, interval_days, due_at, lapses, last_reviewed_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(user_id, word_id) DO UPDATE SET reps=excluded.reps, interval_days=excluded.interval_days,
       due_at=excluded.due_at, lapses=excluded.lapses, last_reviewed_at=excluded.last_reviewed_at`
  ).bind(body.user_id, body.word_id, state.reps, state.interval_days, state.due_at, state.lapses, state.last_reviewed_at).run();
  const stats = await applyReviewStats(c.env.DB, body.user_id, now, body.correct);
  return c.json({ state, stars_awarded: body.correct ? 1 : 0, ...stats });
});

kid.post("/cover", async (c) => {
  const body = await c.req.json<{ user_id: number; unit_id: number; word_id: number }>();
  if (!body.user_id || !body.unit_id || !body.word_id) return c.json({ error: "参数不完整" }, 400);
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO user_unit_word_seen (user_id, unit_id, word_id, first_seen_at) VALUES (?,?,?,?)"
  ).bind(body.user_id, body.unit_id, body.word_id, Date.now()).run();
  return c.json({ ok: true });
});

kid.get("/home", async (c) => {
  const userId = Number(c.req.query("user_id"));
  if (!userId) return c.json({ error: "缺少 user_id" }, 400);
  const now = Date.now();
  const stats = await c.env.DB.prepare(
    "SELECT stars, streak_days FROM user_stats WHERE user_id=?"
  ).bind(userId).first<{ stars: number; streak_days: number }>();
  const due = await c.env.DB.prepare(
    "SELECT COUNT(*) as n FROM user_word_state WHERE user_id=? AND due_at <= ?"
  ).bind(userId, now).first<{ n: number }>();
  const { results } = await c.env.DB.prepare(
    `SELECT u.id as unit_id, u.book, u.unit, u.sort_key,
       COUNT(uw.word_id) AS total,
       SUM(CASE WHEN s.word_id IS NOT NULL THEN 1 ELSE 0 END) AS covered
     FROM units u
     LEFT JOIN unit_words uw ON uw.unit_id = u.id
     LEFT JOIN user_unit_word_seen s
       ON s.unit_id = u.id AND s.user_id = ?1 AND s.word_id = uw.word_id
     GROUP BY u.id
     ORDER BY u.sort_key, u.id`
  ).bind(userId).all<{ unit_id: number; book: string; unit: string; sort_key: number; total: number; covered: number }>();
  const units = results.map((r) => ({
    unit_id: r.unit_id, book: r.book, unit: r.unit,
    total: r.total, covered: r.covered,
    pct: r.total > 0 ? Math.round((r.covered / r.total) * 100) : 0,
  }));
  return c.json({
    stars: stats?.stars ?? 0,
    streak_days: stats?.streak_days ?? 0,
    due_count: due?.n ?? 0,
    units,
  });
});

kid.get("/session/due", async (c) => {
  const userId = Number(c.req.query("user_id"));
  if (!userId) return c.json({ error: "缺少 user_id" }, 400);
  const now = Date.now();
  const { results } = await c.env.DB.prepare(
    `SELECT w.id, w.term, w.pos, w.meaning_cn, w.example_en, w.example_cn,
            s.reps, s.interval_days, s.due_at, s.lapses
     FROM user_word_state s JOIN words w ON w.id = s.word_id
     WHERE s.user_id = ? AND s.due_at <= ?
     ORDER BY s.due_at ASC`
  ).bind(userId, now).all();
  return c.json(results);
});

kid.post("/session/unit", async (c) => {
  const body = await c.req.json<{ user_id: number; unit_id: number }>();
  if (!body.user_id || !body.unit_id) return c.json({ error: "参数不完整" }, 400);
  const { results } = await c.env.DB.prepare(
    `SELECT w.id, w.term, w.pos, w.meaning_cn, w.example_en, w.example_cn,
            COALESCE(s.reps,0) AS reps, COALESCE(s.interval_days,0) AS interval_days,
            COALESCE(s.due_at,0) AS due_at, COALESCE(s.lapses,0) AS lapses
     FROM unit_words uw JOIN words w ON w.id = uw.word_id
     LEFT JOIN user_word_state s ON s.word_id = w.id AND s.user_id = ?
     LEFT JOIN user_unit_word_seen seen
       ON seen.unit_id = uw.unit_id AND seen.word_id = uw.word_id AND seen.user_id = ?
     WHERE uw.unit_id = ? AND seen.word_id IS NULL
     ORDER BY w.term`
  ).bind(body.user_id, body.user_id, body.unit_id).all();
  return c.json(results);
});

export { kid };
