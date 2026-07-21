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

export { kid };
