import { Hono } from "hono";
import type { Env } from "./index";
import { updateSrs, emptyState, type SrsState } from "./srs";
import { parseJsonBody } from "./http";

const kid = new Hono<{ Bindings: Env }>();
const TIME_ZONE = "Asia/Shanghai";

// INTERVALS_DAYS = [0,1,2,4,8,16,30,60] 的 SQL 等价物。
// idx = max(0, min(旧reps+1, 7) - (旧lapses>0 ? 1 : 0))；与 updateSrs 的正确分支一致。
const INTERVAL_CASE = `CASE MAX(MIN(user_word_state.reps + 1, 7) - (user_word_state.lapses > 0), 0)
  WHEN 0 THEN 0 WHEN 1 THEN 1 WHEN 2 THEN 2 WHEN 3 THEN 4
  WHEN 4 THEN 8 WHEN 5 THEN 16 WHEN 6 THEN 30 ELSE 60 END`;

function dayStr(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date(ms));
}

async function applyReviewStats(db: D1Database, userId: number, now: number, correct: boolean) {
  const today = dayStr(now);
  const yesterday = dayStr(now - 86_400_000);
  const starDelta = correct ? 1 : 0;
  // 单条原子 UPSERT：读-改-写版本在并发请求（双端同时玩/重复提交）下会丢星星。
  await db.prepare(
    `INSERT INTO user_stats (user_id, stars, streak_days, last_play_date) VALUES (?1, ?2, 1, ?3)
     ON CONFLICT(user_id) DO UPDATE SET
       stars = user_stats.stars + excluded.stars,
       streak_days = CASE
         WHEN user_stats.last_play_date = excluded.last_play_date THEN user_stats.streak_days
         WHEN user_stats.last_play_date = ?4 THEN user_stats.streak_days + 1
         ELSE 1
       END,
       last_play_date = excluded.last_play_date`
  ).bind(userId, starDelta, today, yesterday).run();
  const row = await db.prepare(
    "SELECT stars, streak_days FROM user_stats WHERE user_id=?"
  ).bind(userId).first<{ stars: number; streak_days: number }>();
  return { stars: row?.stars ?? 0, streak_days: row?.streak_days ?? 0 };
}

kid.get("/users", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, avatar FROM users ORDER BY id"
  ).all();
  return c.json(results);
});

kid.post("/review", async (c) => {
  const body = await c.req.json().catch(() => null) as
    { user_id: number; word_id: number; correct: boolean; source?: string; answer?: string } | null;
  if (!body || typeof body !== "object") return c.json({ error: "请求体不是合法 JSON" }, 400);
  if (!Number.isInteger(body.user_id) || body.user_id <= 0 ||
      !Number.isInteger(body.word_id) || body.word_id <= 0) {
    return c.json({ error: "参数不完整" }, 400);
  }
  if (typeof body.correct !== "boolean") return c.json({ error: "correct 必须为布尔值" }, 400);
  const refs = await c.env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM users WHERE id=?1) AS u, (SELECT COUNT(*) FROM words WHERE id=?2) AS w"
  ).bind(body.user_id, body.word_id).first<{ u: number; w: number }>();
  if (!refs?.u || !refs?.w) return c.json({ error: "用户或单词不存在" }, 404);
  const now = Date.now();
  // 首插路径的值用纯函数算（空状态起转）；冲突路径的转移在 SQL 内原子完成，
  // 杜绝读-改-写在并发（同账号双设备/双开标签）下丢更新。RETURNING 行即权威状态。
  const first = updateSrs(emptyState(now), body.correct, now);
  const row = await c.env.DB.prepare(
    `INSERT INTO user_word_state (user_id, word_id, reps, interval_days, due_at, lapses, last_reviewed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(user_id, word_id) DO UPDATE SET
       reps = CASE WHEN ?8 THEN user_word_state.reps + 1 ELSE 0 END,
       interval_days = CASE WHEN ?8 THEN ${INTERVAL_CASE} ELSE 0 END,
       due_at = CASE WHEN ?8 THEN ?9 + (${INTERVAL_CASE}) * 86400000 ELSE ?9 END,
       lapses = CASE WHEN ?8 THEN user_word_state.lapses ELSE user_word_state.lapses + 1 END,
       last_reviewed_at = ?9
     RETURNING reps, interval_days, due_at, lapses, last_reviewed_at`
  ).bind(
    body.user_id, body.word_id,
    first.reps, first.interval_days, first.due_at, first.lapses, first.last_reviewed_at,
    body.correct ? 1 : 0, now
  ).first<SrsState>();
  const state = row ?? first;
  const stats = await applyReviewStats(c.env.DB, body.user_id, now, body.correct);
  // 错拼事件：append-only 日志，失败只记日志，绝不影响 /review 返回
  if (body.correct === false) {
    try {
      const source = ["daily", "unit", "mistake"].includes(body.source ?? "") ? body.source! : null;
      const answer = typeof body.answer === "string" ? body.answer.slice(0, 100) : null;
      await c.env.DB.prepare(
        "INSERT INTO wrong_answer_events (user_id, word_id, answer, source, created_at) VALUES (?,?,?,?,?)"
      ).bind(body.user_id, body.word_id, answer, source, now).run();
    } catch (e) {
      console.log("wrong_answer_events insert failed", e);
    }
  }
  return c.json({ state, stars_awarded: body.correct ? 1 : 0, ...stats });
});

kid.post("/cover", async (c) => {
  const body = await parseJsonBody<{ user_id: number; unit_id: number; word_id: number }>(c);
  if (!body) return c.json({ error: "请求体不是合法 JSON" }, 400);
  if (!body.user_id || !body.unit_id || !body.word_id) return c.json({ error: "参数不完整" }, 400);
  const refs = await c.env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM users WHERE id=?1) AS u, (SELECT COUNT(*) FROM units WHERE id=?2) AS un, (SELECT COUNT(*) FROM words WHERE id=?3) AS w"
  ).bind(body.user_id, body.unit_id, body.word_id).first<{ u: number; un: number; w: number }>();
  if (!refs?.u || !refs?.un || !refs?.w) return c.json({ error: "用户、单元或单词不存在" }, 404);
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO user_unit_word_seen (user_id, unit_id, word_id, first_seen_at) VALUES (?,?,?,?)"
  ).bind(body.user_id, body.unit_id, body.word_id, Date.now()).run();
  return c.json({ ok: true });
});

kid.get("/home", async (c) => {
  const userId = Number(c.req.query("user_id"));
  if (!userId) return c.json({ error: "缺少 user_id" }, 400);
  const user = await c.env.DB.prepare("SELECT id FROM users WHERE id=?").bind(userId).first();
  if (!user) return c.json({ error: "用户不存在" }, 404);
  const now = Date.now();
  const stats = await c.env.DB.prepare(
    "SELECT stars, streak_days FROM user_stats WHERE user_id=?"
  ).bind(userId).first<{ stars: number; streak_days: number }>();
  const due = await c.env.DB.prepare(
    "SELECT COUNT(*) as n FROM user_word_state WHERE user_id=? AND due_at <= ?"
  ).bind(userId, now).first<{ n: number }>();
  const mistakes = await c.env.DB.prepare(
    "SELECT COUNT(*) as n FROM user_word_state WHERE user_id=? AND lapses > 0 AND reps < 2"
  ).bind(userId).first<{ n: number }>();
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
    mistake_count: mistakes?.n ?? 0,
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

kid.get("/session/mistakes", async (c) => {
  const userId = Number(c.req.query("user_id"));
  if (!userId) return c.json({ error: "缺少 user_id" }, 400);
  // 错题本成员纯派生：错过(lapses>0)且毕业后连对不足 2 次(reps<2)
  const { results } = await c.env.DB.prepare(
    `SELECT w.id, w.term, w.pos, w.meaning_cn, w.example_en, w.example_cn,
            s.reps, s.interval_days, s.due_at, s.lapses
     FROM user_word_state s JOIN words w ON w.id = s.word_id
     WHERE s.user_id = ? AND s.lapses > 0 AND s.reps < 2
     ORDER BY RANDOM()`
  ).bind(userId).all();
  return c.json(results);
});

kid.post("/session/unit", async (c) => {
  const body = await parseJsonBody<{ user_id: number; unit_id: number }>(c);
  if (!body) return c.json({ error: "请求体不是合法 JSON" }, 400);
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
     ORDER BY RANDOM()`
  ).bind(body.user_id, body.user_id, body.unit_id).all();
  return c.json(results);
});

export { kid };
