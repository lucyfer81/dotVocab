import { DAILY_ITEM_COUNTS_SQL, dayEndMs, dayStr } from "./daily-list";
import { POOL_SENSES_SQL } from "./vocabulary";

const DAY_MS = 86_400_000;

function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(day) + days * DAY_MS).toISOString().slice(0, 10);
}

// 学习日期取清单归属日，事件只通过条目固定的首答指针读取。
const FIRST_ANSWERS_SQL = `
  SELECT h.study_date AS day, i.sense_id, i.kind, i.status, e.correct
  FROM daily_lists h
  JOIN daily_items i ON i.list_id = h.id
  JOIN answer_events e ON e.event_id = i.first_event_id AND e.source = 'daily'
    AND e.item_id = i.id AND e.user_id = h.user_id AND e.sense_id = i.sense_id
  WHERE h.user_id = ?1 AND h.study_date BETWEEN ?2 AND ?3`;

interface Score {
  correct: number;
  total: number;
}

interface Today {
  total: number;
  done: number;
  correction: number;
  pending: number;
  due: number;
  new: number;
}

type RepeatedMistake = {
  senseId: string;
  term: string;
  meaning: string;
  errorDays: number;
  latestDay: string;
  latestCorrect: number;
};

export async function readParentDashboard(db: D1Database, userId: number, now: number) {
  const day = dayStr(now);
  const recentStart = shiftDay(day, -6);
  const monthStart = shiftDay(day, -29);
  const monday = shiftDay(day, -((new Date(day).getUTCDay() + 6) % 7));
  const weekStarts = Array.from({ length: 8 }, (_, i) => shiftDay(monday, (i - 7) * 7));
  const tomorrow = shiftDay(day, 1);

  const [userResult, todayResult, history, mistakes, corrections, forecast] = await db.batch([
    db.prepare("SELECT id FROM users WHERE id = ?").bind(userId),
    db.prepare(`
      SELECT ${DAILY_ITEM_COUNTS_SQL},
             COUNT(CASE WHEN i.kind = 'due' THEN 1 END) AS due,
             COUNT(CASE WHEN i.kind = 'new' THEN 1 END) AS new
      FROM daily_lists h LEFT JOIN daily_items i ON i.list_id = h.id
      WHERE h.user_id = ? AND h.study_date = ?
      GROUP BY h.id`).bind(userId, day),
    db.prepare(`
      WITH answers AS (${FIRST_ANSWERS_SQL})
      SELECT day, SUM(correct) AS correct, COUNT(*) AS total
      FROM answers WHERE kind = 'due' GROUP BY day ORDER BY day`)
      .bind(userId, weekStarts[0], day),
    db.prepare(`
      WITH answers AS (${FIRST_ANSWERS_SQL}), repeated AS (
        SELECT sense_id, COUNT(DISTINCT day) AS errorDays, MAX(day) AS lastErrorDay
        FROM answers WHERE correct = 0
        GROUP BY sense_id HAVING COUNT(DISTINCT day) >= 2
        ORDER BY errorDays DESC, lastErrorDay DESC, sense_id LIMIT 5
      )
      SELECT s.sense_id AS senseId, s.term, s.meaning, r.errorDays,
             a.day AS latestDay, a.correct AS latestCorrect
      FROM repeated r
      JOIN curriculum_senses s ON s.sense_id = r.sense_id
      JOIN answers a ON a.sense_id = r.sense_id AND a.day = (
        SELECT MAX(b.day) FROM answers b WHERE b.sense_id = r.sense_id
      )
      ORDER BY r.errorDays DESC, r.lastErrorDay DESC, r.sense_id`)
      .bind(userId, monthStart, day),
    db.prepare(`
      WITH answers AS (${FIRST_ANSWERS_SQL})
      SELECT COUNT(*) AS completed, COUNT(next.day) AS total,
             COALESCE(SUM(next.correct), 0) AS correct
      FROM answers a
      LEFT JOIN answers next ON next.sense_id = a.sense_id AND next.kind = 'due' AND next.day = (
        SELECT MIN(b.day) FROM answers b
        WHERE b.sense_id = a.sense_id AND b.kind = 'due' AND b.day > a.day
      )
      WHERE a.correct = 0 AND a.status = 'done'`).bind(userId, monthStart, day),
    db.prepare(`
      SELECT COALESCE((SELECT daily_limit FROM user_quotas WHERE user_id = ?1), 10) AS quota,
             COUNT(*) AS due
      FROM user_cards c
      WHERE c.user_id = ?1 AND c.due_at <= ?2 AND c.sense_id IN (${POOL_SENSES_SQL})`)
      .bind(userId, dayEndMs(tomorrow)),
  ]);
  if (!userResult.results.length) return null;

  const dailyScores = history.results as (Score & { day: string })[];
  function sumScores(from: string, through: string): Score {
    const score = { correct: 0, total: 0 };
    for (const row of dailyScores) {
      if (row.day < from || row.day > through) continue;
      score.correct += row.correct;
      score.total += row.total;
    }
    return score;
  }

  const { completed, total, correct } = corrections.results[0] as Score & { completed: number };
  const { quota, due } = forecast.results[0] as { quota: number; due: number };
  return {
    today: (todayResult.results[0] as Today | undefined) ?? null,
    recentReview: sumScores(recentStart, day),
    repeatedMistakes: mistakes.results as RepeatedMistake[],
    correctionReview: { completed, total, correct, waiting: completed - total },
    tomorrow: { due, quota, scheduled: Math.min(due, quota) },
    weeks: weekStarts.map(start => ({
      start, current: start === monday, ...sumScores(start, shiftDay(start, 6)),
    })),
  };
}
