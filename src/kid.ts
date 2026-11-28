import { Hono } from "hono";
import type { Env } from "./index";
import { updateSrs, emptyState, type SrsState } from "./srs";
import { parseJsonBody } from "./http";
import { DAILY_ITEM_COUNTS_SQL, dayStr, openDailyList } from "./daily-list";
import { submitDailyAnswer, type DailyAction } from "./daily-answer";

const kid = new Hono<{ Bindings: Env }>();

// INTERVALS_DAYS = [0,1,2,4,8,16,30,60] 的 SQL 等价物。
// idx = max(0, min(旧reps+1, 7) - (旧lapses>0 ? 1 : 0))；与 updateSrs 的正确分支一致。
const INTERVAL_CASE = `CASE MAX(MIN(user_word_state.reps + 1, 7) - (user_word_state.lapses > 0), 0)
  WHEN 0 THEN 0 WHEN 1 THEN 1 WHEN 2 THEN 2 WHEN 3 THEN 4
  WHEN 4 THEN 8 WHEN 5 THEN 16 WHEN 6 THEN 30 ELSE 60 END`;

// 星星/连续学习天数：单条原子 UPSERT（读-改-写版本在并发请求下会丢星星）。
// 旧 /review（word 路径）与 /api/review sense 加练路径共用同一段 SQL。
const UPSERT_STATS_SQL = `INSERT INTO user_stats (user_id, stars, streak_days, last_play_date) VALUES (?1, ?2, 1, ?3)
  ON CONFLICT(user_id) DO UPDATE SET
    stars = user_stats.stars + excluded.stars,
    streak_days = CASE
      WHEN user_stats.last_play_date = excluded.last_play_date THEN user_stats.streak_days
      WHEN user_stats.last_play_date = ?4 THEN user_stats.streak_days + 1
      ELSE 1
    END,
    last_play_date = excluded.last_play_date`;

async function applyReviewStats(db: D1Database, userId: number, now: number, correct: boolean) {
  const today = dayStr(now);
  const yesterday = dayStr(now - 86_400_000);
  const starDelta = correct ? 1 : 0;
  await db.prepare(UPSERT_STATS_SQL).bind(userId, starDelta, today, yesterday).run();
  const row = await db.prepare(
    "SELECT stars, streak_days FROM user_stats WHERE user_id=?"
  ).bind(userId).first<{ stars: number; streak_days: number }>();
  return { stars: row?.stars ?? 0, streak_days: row?.streak_days ?? 0 };
}

// accepted_json（JSON 字符串数组）→ string[]；解析失败或形状不对回空数组（fail-closed）。
function parseAccepted(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

async function userExists(db: D1Database, userId: number) {
  return db.prepare("SELECT id FROM users WHERE id=?").bind(userId).first();
}

kid.get("/users", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, avatar FROM users ORDER BY id"
  ).all();
  return c.json(results);
});

kid.post("/review", async (c) => {
  const body = await c.req.json().catch(() => null) as
    | {
        // 旧 word 路径（换库前客户端，保持原样兼容；字段风格沿用原契约，运行时仍逐项校验）
        user_id: number; word_id: number;
        // sense 加练路径（任务 7）：单元练习/错词本自主加练的练习日志通道
        userId?: number; senseId?: string; eventId?: string;
        correct: boolean; source?: string; answer?: string;
      }
    | null;
  if (!body || typeof body !== "object") return c.json({ error: "请求体不是合法 JSON" }, 400);

  // ---- sense 加练路径：不调 /daily/answer、不写 user_cards（不改 FSRS）、
  // 不完成每日条目；写 answer_events（item_id NULL、rating NULL、卡片前后 NULL）
  // 作为练习日志；星星沿用既有语义（答对 +1，与旧 /review 同一张表原子 UPSERT）。
  if (body.senseId !== undefined) {
    const userId = body.userId;
    const senseId = body.senseId;
    if (typeof userId !== "number" || !Number.isSafeInteger(userId) || userId <= 0 ||
        typeof senseId !== "string" || senseId.length === 0 || senseId.length > 100) {
      return c.json({ error: "参数不完整" }, 400);
    }
    if (typeof body.eventId !== "string" || body.eventId.length === 0 || body.eventId.length > 100) {
      return c.json({ error: "eventId 必须为 1-100 字符的字符串" }, 400);
    }
    if (typeof body.correct !== "boolean") return c.json({ error: "correct 必须为布尔值" }, 400);
    // source 由每日流程独占：加练通道不得伪造每日作答（错词本只派生 source='daily'）
    if (body.source !== "unit" && body.source !== "mistake") {
      return c.json({ error: "加练 source 必须为 unit 或 mistake" }, 400);
    }
    const refs = await c.env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM users WHERE id=?1) AS u,
              (SELECT COUNT(*) FROM curriculum_senses WHERE sense_id=?2) AS s`
    ).bind(userId, senseId).first<{ u: number; s: number }>();
    if (!refs?.u || !refs?.s) return c.json({ error: "用户或词义不存在" }, 404);

    // 幂等回放：同 eventId 且归属同一孩子 → 原样返回当时结果（纯读，零副作用）
    const replay = await c.env.DB.prepare(
      "SELECT result_json FROM answer_events WHERE event_id=? AND user_id=?"
    ).bind(body.eventId, userId).first<{ result_json: string | null }>();
    const replayBase = replay?.result_json != null ? JSON.parse(replay.result_json) as Record<string, unknown> : null;

    // 跨用户 eventId 碰撞守卫（event_id 是全局 PK，与任务 6 的服务端防御呼应）
    const owner = await c.env.DB.prepare(
      "SELECT user_id FROM answer_events WHERE event_id=?"
    ).bind(body.eventId).first<{ user_id: number }>();
    if (owner && owner.user_id !== userId) {
      return c.json({ error: "eventId 已被其他作答占用" }, 409);
    }
    if (replayBase) {
      // 同孩子重发：星星/连击读当前值回填（练习不产生新副作用）
      const stats = await c.env.DB.prepare(
        "SELECT stars, streak_days FROM user_stats WHERE user_id=?"
      ).bind(userId).first<{ stars: number; streak_days: number }>();
      return c.json({ ...replayBase, stars: stats?.stars ?? 0, streak_days: stats?.streak_days ?? 0 });
    }

    const now = Date.now();
    const correct = body.correct;
    // 答案统一 trim + 小写后截断 100 字符存储（与每日作答同一归一）；答对记 NULL
    const answer = correct
      ? null
      : (typeof body.answer === "string" ? body.answer.trim().toLowerCase().slice(0, 100) : null);
    const result = {
      eventId: body.eventId,
      applied: true,
      correct,
      starsAwarded: correct ? 1 : 0,
    };
    const today = dayStr(now);
    const yesterday = dayStr(now - 86_400_000);
    try {
      // 单事务：事件、星星、回读一起落库；INSERT 撞 PK（并发重发）整批回滚后走回放。
      const batchResults = await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO answer_events
             (event_id, user_id, sense_id, item_id, source, action, answer, correct,
              created_at, rating, card_before_json, card_after_json, result_json)
           VALUES (?, ?, ?, NULL, ?, 'spell', ?, ?, ?, NULL, NULL, NULL, ?)`
        ).bind(body.eventId, userId, senseId, body.source, answer, correct ? 1 : 0, now, JSON.stringify(result)),
        c.env.DB.prepare(UPSERT_STATS_SQL).bind(userId, correct ? 1 : 0, today, yesterday),
        c.env.DB.prepare("SELECT stars, streak_days FROM user_stats WHERE user_id=?").bind(userId),
      ]);
      const stats = batchResults[2].results[0] as { stars: number; streak_days: number } | undefined;
      return c.json({ ...result, stars: stats?.stars ?? 0, streak_days: stats?.streak_days ?? 0 });
    } catch {
      // 并发同 eventId 落库撞 PK：重读回放（归属校验后原样返回），不重复计分
      const again = await c.env.DB.prepare(
        "SELECT user_id, result_json FROM answer_events WHERE event_id=?"
      ).bind(body.eventId).first<{ user_id: number; result_json: string | null }>();
      if (again?.result_json != null) {
        if (again.user_id !== userId) return c.json({ error: "eventId 已被其他作答占用" }, 409);
        const stats = await c.env.DB.prepare(
          "SELECT stars, streak_days FROM user_stats WHERE user_id=?"
        ).bind(userId).first<{ stars: number; streak_days: number }>();
        return c.json({ ...(JSON.parse(again.result_json) as Record<string, unknown>), stars: stats?.stars ?? 0, streak_days: stats?.streak_days ?? 0 });
      }
      throw new Error("practice log insert failed");
    }
  }

  // ---- 旧 word 路径（保持原样）：整型 word_id，写 user_word_state 旧阶梯 ----
  if (!Number.isSafeInteger(body.user_id) || body.user_id <= 0 ||
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

// 首页（新世界契约）：
//   daily        —— 今日已生成清单的只读快照（绝不在首页生成/锁定清单）；
//   mistakeCount —— 错词本大小：answer_events 中 source='daily' 且答错的去重 sense 数；
//   units        —— 仅共享池开放单元，covered = 该孩子有 user_cards 的词义数。
kid.get("/home", async (c) => {
  const userId = Number(c.req.query("user_id"));
  if (!Number.isSafeInteger(userId) || userId <= 0) return c.json({ error: "缺少 user_id" }, 400);
  if (!(await userExists(c.env.DB, userId))) return c.json({ error: "用户不存在" }, 404);
  const today = dayStr(Date.now());
  const stats = await c.env.DB.prepare(
    "SELECT stars, streak_days FROM user_stats WHERE user_id=?"
  ).bind(userId).first<{ stars: number; streak_days: number }>();
  const dailyRow = await c.env.DB.prepare(
    `SELECT h.study_date AS day, h.daily_limit AS dailyLimit, ${DAILY_ITEM_COUNTS_SQL}
     FROM daily_lists h
     LEFT JOIN daily_items i ON i.list_id = h.id
     WHERE h.user_id = ? AND h.study_date = ?
     GROUP BY h.id`
  ).bind(userId, today).first<{ day: string; dailyLimit: number; total: number; done: number }>();
  const mistakeRow = await c.env.DB.prepare(
    `SELECT COUNT(DISTINCT sense_id) AS n FROM answer_events
     WHERE user_id = ? AND source = 'daily' AND correct = 0`
  ).bind(userId).first<{ n: number }>();
  const { results } = await c.env.DB.prepare(
    `SELECT u.id AS unitId, u.book, u.book_title AS bookTitle, u.unit,
            COUNT(x.sense_id) AS total,
            COUNT(c.sense_id) AS covered
     FROM pool_units p
     JOIN curriculum_units u ON u.id = p.unit_id
     JOIN curriculum_unit_senses x ON x.unit_id = u.id
     LEFT JOIN user_cards c ON c.user_id = ? AND c.sense_id = x.sense_id
     GROUP BY u.id
     ORDER BY u.book_order, u.unit, u.id`
  ).bind(userId).all<{ unitId: number; book: string; bookTitle: string; unit: number; total: number; covered: number }>();
  const units = results.map((r) => ({
    unitId: r.unitId, book: r.book, bookTitle: r.bookTitle, unit: r.unit,
    total: r.total, covered: r.covered,
    pct: r.total > 0 ? Math.round((r.covered / r.total) * 100) : 0,
  }));
  return c.json({
    stars: stats?.stars ?? 0,
    streak_days: stats?.streak_days ?? 0,
    daily: dailyRow
      ? { day: dailyRow.day, limit: dailyRow.dailyLimit, done: dailyRow.done, total: dailyRow.total }
      : null,
    mistakeCount: mistakeRow?.n ?? 0,
    units,
  });
});

// 错词本（新世界数据源）：answer_events 中 source='daily' 且 correct=0 的去重词义。
// 订正完成不清除当天首次失败；自主加练（source unit/mistake）不入本。
kid.get("/mistakes", async (c) => {
  const userId = Number(c.req.query("user_id"));
  if (!Number.isSafeInteger(userId) || userId <= 0) return c.json({ error: "缺少 user_id" }, 400);
  if (!(await userExists(c.env.DB, userId))) return c.json({ error: "用户不存在" }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT e.sense_id AS senseId, s.term, s.meaning, s.accepted_json AS acceptedJson,
            MAX(e.created_at) AS lastWrongAt
     FROM answer_events e
     JOIN curriculum_senses s ON s.sense_id = e.sense_id
     WHERE e.user_id = ? AND e.source = 'daily' AND e.correct = 0
     GROUP BY e.sense_id
     ORDER BY lastWrongAt DESC`
  ).bind(userId).all<{ senseId: string; term: string; meaning: string; acceptedJson: string; lastWrongAt: number }>();
  return c.json(results.map((r) => ({
    senseId: r.senseId,
    term: r.term,
    meaning: r.meaning,
    accepted: parseAccepted(r.acceptedJson),
    lastWrongAt: r.lastWrongAt,
  })));
});

// 单元练习词表（新世界数据源）：共享池开放单元的全部词义，按教材行序，
// 附 accepted 供客户端按别名判定。池外单元一律 404（前端只显示池内星球）。
kid.get("/unit-words", async (c) => {
  const unitId = Number(c.req.query("unit_id"));
  if (!Number.isSafeInteger(unitId) || unitId <= 0) return c.json({ error: "缺少 unit_id" }, 400);
  const open = await c.env.DB.prepare(
    "SELECT u.id FROM curriculum_units u JOIN pool_units p ON p.unit_id = u.id WHERE u.id = ?"
  ).bind(unitId).first<{ id: number }>();
  if (!open) return c.json({ error: "单元不在共享池" }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT x.sense_id AS senseId, s.term, s.meaning, s.accepted_json AS acceptedJson
     FROM curriculum_unit_senses x
     JOIN curriculum_senses s ON s.sense_id = x.sense_id
     WHERE x.unit_id = ?
     ORDER BY x.row_order, x.sense_id`
  ).bind(unitId).all<{ senseId: string; term: string; meaning: string; acceptedJson: string }>();
  return c.json(results.map((r) => ({
    senseId: r.senseId,
    term: r.term,
    meaning: r.meaning,
    accepted: parseAccepted(r.acceptedJson),
  })));
});

// 每日清单：生成并固定当天清单（并发抢占与选词规则见 src/daily-list.ts）。
kid.post("/daily/open", async (c) => {
  const body = await parseJsonBody<{ userId: number }>(c);
  if (!body || !Number.isSafeInteger(body.userId) || body.userId <= 0) {
    return c.json({ error: "参数不完整" }, 400);
  }
  if (!(await userExists(c.env.DB, body.userId))) return c.json({ error: "用户不存在" }, 404);
  return c.json(await openDailyList(c.env.DB, body.userId, Date.now()));
});

// 每日作答：首次作答/订正与奖励一次生效。抢占、幂等回放、迟交 409 与
// 订正推进逻辑都在 submitDailyAnswer（见 src/daily-answer.ts），此处只做
// 参数校验与状态码映射：stale_day→409，not_found→404。
kid.post("/daily/answer", async (c) => {
  const body = await parseJsonBody<{
    userId: number; itemId: number; eventId: string; action: string; answer?: string;
  }>(c);
  if (!body) return c.json({ error: "请求体不是合法 JSON" }, 400);
  if (!Number.isSafeInteger(body.userId) || body.userId <= 0 ||
      !Number.isSafeInteger(body.itemId) || body.itemId <= 0) {
    return c.json({ error: "参数不完整" }, 400);
  }
  if (typeof body.eventId !== "string" || body.eventId.length === 0 || body.eventId.length > 100) {
    return c.json({ error: "eventId 必须为 1-100 字符的字符串" }, 400);
  }
  if (body.action !== "spell" && body.action !== "reveal") {
    return c.json({ error: "action 必须为 spell 或 reveal" }, 400);
  }
  if (body.action === "spell" && typeof body.answer !== "string") {
    return c.json({ error: "spell 作答必须携带 answer 字符串" }, 400);
  }
  if (!(await userExists(c.env.DB, body.userId))) return c.json({ error: "用户不存在" }, 404);
  const outcome = await submitDailyAnswer(c.env.DB, {
    userId: body.userId,
    itemId: body.itemId,
    eventId: body.eventId,
    action: body.action as DailyAction,
    answer: typeof body.answer === "string" ? body.answer : null,
  }, Date.now());
  if (!outcome.ok) {
    return outcome.code === "stale_day"
      ? c.json({ error: "清单已过日，请重新打开今日清单" }, 409)
      : c.json({ error: "条目不存在或不属于该孩子" }, 404);
  }
  return c.json(outcome.result);
});

export { kid };
