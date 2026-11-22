// 每日作答（POST /api/daily/answer）：首次作答、订正与奖励一次生效。
//
// 并发契约（计划 Review Focus #4/#5）：
//   - 两台设备对同一条目给出相反答案，只认先成功持久化的首次作答。
//     抢占是一条独立的条件 UPDATE：status='pending'（且 first_event_id IS NULL，
//     防御性双条件）且归属+当日清单才允许，并把 first_event_id 钉成本请求的
//     eventId；SQLite 单写者把并发 UPDATE 串行化，第二个提交者重新求值 WHERE
//     后匹配 0 行——meta.changes>0 者即唯一胜者（与 kid.ts /review 的原子
//     upsert 同一机制）。胜者在独占期内把事件、卡片、星星放进一个 D1 batch
//     无条件写入；落选方一个字节都不写，改为读回权威状态。
//     注意：若某请求的预读发生在胜者落库之后（两段往返天然存在此窗口），
//     它会按条目当前状态走订正完成分支（payload 与订正不可区分，契约无阶段
//     字段）——此时 applied 可为真，但评级/加星/卡片仍只来自首次作答那一次
//     （订正不评级不加星不碰卡），"只产生一次评级"的不变量在任何交叠下成立。
//   - 昨晚打开的页面次日迟交：抢占语句的 WHERE 内含 study_date = 上海当日
//     dayStr(nowMs)，不匹配则整条 UPDATE 匹配 0 行、零副作用，路由回 409。
//     请求前的预读只用于把错误分类成 404 / 409，真正的守卫在抢占语句内，
//     杜绝预读与提交之间的 TOCTOU；抢占落选后还会重读一次权威状态再分类。
//   - 幂等：answer_events.event_id 是主键。重发/断线重试先按 eventId（带
//     归属校验）查询，命中即原样返回当时存进 result_json 的权威返回。
//
// 为什么不是"单批次 + 每条副作用带 EXISTS 守卫"：实现岗在 GREEN 轮实测
// 该形态在本环境不可靠——同为 INSERT...SELECT...WHERE 守卫，胜者的事件
// 写入而卡片不写入、订正事件不写入、抢占落选方的事件反而写入。故改用
// 两段式：只有抢占语句需要条件语义（单条 UPDATE 天然原子），胜者独占期
// 内的写入全部使用本仓库已验证的 INSERT...VALUES ... ON CONFLICT 形态。
// 代价：抢占与落库分两次往返，进程在两段之间崩溃会留下"已抢占未落库"
// 的条目（极小概率；重试同 eventId 会得到 already_done 权威状态，不会
// 重复计分）。409 无副作用与"只认先持久化"两个不变量不受影响。
//
// 判定：action='reveal' 直接 Again（首次看答案，answer 记 NULL）；
// action='spell' 按 curriculum_senses.accepted_json（JSON 字符串数组）
// trim + 小写比较；answer 统一 trim + 小写后截断 100 字符存储。
// 订正提交（条目 status='correction'）：答对→推进条目到 done；答错或
// 看答案→条目保持 correction（只记录一条订正事件）。订正不触碰
// user_cards / user_stats / 首次错误记录；first_event_id 永远保留首次
// 作答事件。已 done 的条目不再接受任何作答。
//
// 错拼记录（主代理裁决）：新世界只有 TEXT 型 sense_id，旧 wrong_answer_events
// 的 word_id INTEGER NOT NULL 无从承载，写占位值会丢词义归属并污染按
// word_id 级联清理的旧日志；首次错拼由 answer_events（sense_id + answer +
// correct=0 + action + rating + 卡片前后状态）完整承载，每日作答不写旧表。
// 任务 7 的错词本从 answer_events 派生（correct=0 的每日作答）。
//
// 卡片：消费任务 4 的 advanceCard（ts-fsrs，wire 格式 "fsrs-v1:"+JSON），
// card_before_json / card_after_json 存事件前后状态供审计；user_cards 只由
// 每日首次作答写入（订正与自主加练不再调度）。星星/连续学习天数沿用
// kid.ts applyReviewStats 的单条原子 UPSERT 语义，与旧 /review 并发写同表
// 安全。SQL 一律匿名 ? 占位、按序绑定，不用编号参数。

import { advanceCard, type CardRating } from "./fsrs";
import { dayStr } from "./daily-list";

export type DailyAction = "spell" | "reveal";

export interface DailyAnswerInput {
  userId: number;
  itemId: number;
  eventId: string;
  action: DailyAction;
  /** spell 的原始答案；reveal 恒为 null */
  answer: string | null;
}

export interface DailyAnswerItemView {
  id: number;
  senseId: string;
  term: string;
  meaning: string;
  status: string;
}

export type DailyStage = "first" | "correction" | "already_done";

export interface DailyAnswerResult {
  eventId: string;
  /** 本事件是否是生效的那次作答（并发落选/重复条目为 false） */
  applied: boolean;
  /** first=首次作答；correction=订正；already_done=条目已完成后的迟到提交 */
  stage: DailyStage;
  /** 权威条目状态 */
  item: DailyAnswerItemView;
  /** 条目已持久化的判定（首次作答或订正）；拿不到时为 null */
  correct: boolean | null;
  /** 仅首次作答有 Good/Again；订正为 null */
  rating: "Good" | "Again" | null;
  /** 本次请求实际新增的星星（只有首次答对且 applied 才为 1） */
  starsAwarded: number;
}

export type DailyAnswerOutcome =
  | { ok: true; result: DailyAnswerResult }
  | { ok: false; code: "not_found" | "stale_day" };

interface ItemRow {
  id: number;
  senseId: string;
  status: string;
  userId: number;
  studyDate: string;
  term: string;
  meaning: string;
  acceptedJson: string;
  cardJson: string | null;
}

interface AuthRow {
  id: number;
  senseId: string;
  status: string;
  term: string;
  meaning: string;
  studyDate: string;
  /** 首次作答事件（first_event_id）里的 correct / rating；用于落选方回显权威结果 */
  firstCorrect: number | null;
  firstRating: string | null;
}

// 幂等回放：event_id 命中且归属同一孩子才回原结果，防止拿别人的 eventId 探测。
const REPLAY_SQL = `
SELECT e.result_json AS resultJson
FROM answer_events e
JOIN daily_items i ON i.id = e.item_id
JOIN daily_lists h ON h.id = i.list_id
WHERE e.event_id = ? AND h.user_id = ?`;

// 预读条目+归属+可接受答案+本人卡片（仅分类错误与准备参数；真正的守卫在抢占语句内）。
const LOAD_ITEM_SQL = `
SELECT i.id, i.sense_id AS senseId, i.status,
       h.user_id AS userId, h.study_date AS studyDate,
       s.term, s.meaning, s.accepted_json AS acceptedJson,
       c.card_json AS cardJson
FROM daily_items i
JOIN daily_lists h ON h.id = i.list_id
JOIN curriculum_senses s ON s.sense_id = i.sense_id
LEFT JOIN user_cards c ON c.user_id = h.user_id AND c.sense_id = i.sense_id
WHERE i.id = ?`;

// 首次作答抢占：status='pending' 且 first_event_id 为空 且归属+当日清单才允许；
// 把 first_event_id 钉成本事件。单条 UPDATE 原子（SQLite 单写者串行化），
// meta.changes>0 即唯一胜者。first_event_id IS NULL 与 status='pending' 互为
// 等价不变量（该列仅由本语句写入），双条件是主代理要求的防御性加固。
// 跨用户事件守卫（审阅 Important-1）：event_id 是全局 PK，若本请求的 eventId
// 已被其他孩子的作答持久化（客户端可碰撞值），抢占必须失配——否则胜者独占期
// 的 INSERT 撞 PK → 500 + 已抢占未落库悬挂态。命中守卫即按落选零写入处理。
const CLAIM_FIRST_SQL = `
UPDATE daily_items
SET status = ?, first_event_id = ?
WHERE id = ? AND status = 'pending' AND first_event_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM answer_events WHERE event_id = ? AND user_id <> ?
  )
  AND EXISTS (
    SELECT 1 FROM daily_lists h
    WHERE h.id = daily_items.list_id AND h.user_id = ? AND h.study_date = ?
  )`;

// 胜者独占期内无条件写入（形状与 kid.ts /review 的 INSERT...VALUES...ON CONFLICT 一致）。
const INSERT_FIRST_EVENT_SQL = `
INSERT INTO answer_events
  (event_id, user_id, sense_id, item_id, source, action, answer, correct,
   created_at, rating, card_before_json, card_after_json, result_json)
VALUES (?, ?, ?, ?, 'daily', ?, ?, ?, ?, ?, ?, ?, ?)`;

const UPSERT_CARD_SQL = `
INSERT INTO user_cards (user_id, sense_id, due_at, card_json)
VALUES (?, ?, ?, ?)
ON CONFLICT (user_id, sense_id) DO UPDATE SET
  due_at = excluded.due_at,
  card_json = excluded.card_json`;

// 星星/连续学习天数：与 kid.ts applyReviewStats 相同的原子 UPSERT 语义
// （starDelta 参数化：答对 +1、答错 0——答错也记录学习日并续连击，三通道一致；
// today/yesterday 用上海日），与旧 /review 并发写同表安全。
const UPSERT_STATS_SQL = `
INSERT INTO user_stats (user_id, stars, streak_days, last_play_date)
VALUES (?, ?, 1, ?)
ON CONFLICT (user_id) DO UPDATE SET
  stars = user_stats.stars + excluded.stars,
  streak_days = CASE
    WHEN user_stats.last_play_date = excluded.last_play_date THEN user_stats.streak_days
    WHEN user_stats.last_play_date = ? THEN user_stats.streak_days + 1
    ELSE 1
  END,
  last_play_date = excluded.last_play_date`;

// 订正推进：条目仍为 correction 且归属+当日才把条目推到 done；first_event_id 不动。
// 跨用户事件守卫同 CLAIM_FIRST（审阅 Important-1）。
const CLAIM_CORRECTION_DONE_SQL = `
UPDATE daily_items
SET status = 'done'
WHERE id = ? AND status = 'correction'
  AND NOT EXISTS (
    SELECT 1 FROM answer_events WHERE event_id = ? AND user_id <> ?
  )
  AND EXISTS (
    SELECT 1 FROM daily_lists h
    WHERE h.id = daily_items.list_id AND h.user_id = ? AND h.study_date = ?
  )`;

// 订正保持：确认条目仍为 correction（自等值 UPDATE，meta.changes>0 即仍可订正），
// 随后才记录失败订正事件，防止对已完成条目留下语义失真的订正日志。
// 跨用户事件守卫同 CLAIM_FIRST（审阅 Important-1）。
const KEEP_CORRECTION_SQL = `
UPDATE daily_items
SET status = 'correction'
WHERE id = ? AND status = 'correction'
  AND NOT EXISTS (
    SELECT 1 FROM answer_events WHERE event_id = ? AND user_id <> ?
  )
  AND EXISTS (
    SELECT 1 FROM daily_lists h
    WHERE h.id = daily_items.list_id AND h.user_id = ? AND h.study_date = ?
  )`;

const INSERT_CORRECTION_EVENT_SQL = `
INSERT INTO answer_events
  (event_id, user_id, sense_id, item_id, source, action, answer, correct,
   created_at, rating, card_before_json, card_after_json, result_json)
VALUES (?, ?, ?, ?, 'daily', ?, ?, ?, ?, NULL, NULL, NULL, ?)`;

// 权威回读：抢占落选方 / 已完成条目的响应来源（含首次事件的判定回显）。
const READ_AUTH_SQL = `
SELECT i.id, i.sense_id AS senseId, i.status, s.term, s.meaning,
       h.study_date AS studyDate,
       (SELECT e.correct FROM answer_events e WHERE e.event_id = i.first_event_id) AS firstCorrect,
       (SELECT e.rating FROM answer_events e WHERE e.event_id = i.first_event_id) AS firstRating
FROM daily_items i
JOIN daily_lists h ON h.id = i.list_id
JOIN curriculum_senses s ON s.sense_id = i.sense_id
WHERE i.id = ?`;

// spell 按 accepted_json 判定（trim + 小写，提交答案同样小写归一）；
// reveal 直接判错（首次看答案）。accepted_json 解析失败按判错兜底
// （fail-closed，孩子仍可订正）。
function judge(action: DailyAction, normalizedAnswer: string | null, acceptedJson: string): boolean {
  if (action === "reveal" || normalizedAnswer == null) return false;
  let accepted: unknown[];
  try {
    const parsed: unknown = JSON.parse(acceptedJson);
    if (!Array.isArray(parsed)) return false;
    accepted = parsed;
  } catch {
    return false;
  }
  return accepted.some(
    (a) => typeof a === "string" && a.trim().toLowerCase() === normalizedAnswer,
  );
}

function loserResult(row: AuthRow, eventId: string, stage: DailyStage): DailyAnswerResult {
  return {
    eventId,
    applied: false,
    stage,
    item: { id: row.id, senseId: row.senseId, term: row.term, meaning: row.meaning, status: row.status },
    correct: row.firstCorrect == null ? null : row.firstCorrect === 1,
    rating: (row.firstRating as "Good" | "Again" | null) ?? null,
    starsAwarded: 0,
  };
}

// 抢占落选后的统一出口：重读权威状态，区分"条目消失"(404)、"当日已翻篇"(409)
// 与"被他人抢占"(200 落选响应)。落选路径全程零写入。
async function readAuthOr404(db: D1Database, itemId: number) {
  return db.prepare(READ_AUTH_SQL).bind(itemId).first<AuthRow>();
}

export async function submitDailyAnswer(
  db: D1Database,
  input: DailyAnswerInput,
  nowMs: number,
): Promise<DailyAnswerOutcome> {
  const day = dayStr(nowMs);
  const userId = input.userId;
  const itemId = input.itemId;
  const eventId = input.eventId;
  // 答案统一 trim + 小写后截断 100 字符存储；判定也用同一规范化结果。
  const normalizedAnswer =
    input.action === "spell" && input.answer != null
      ? input.answer.trim().toLowerCase().slice(0, 100)
      : null;

  // 1) 幂等回放：同 eventId（且归属同一孩子）重发返回当时的权威返回。
  const replayed = await db.prepare(REPLAY_SQL).bind(eventId, userId)
    .first<{ resultJson: string | null }>();
  if (replayed?.resultJson != null) {
    return { ok: true, result: JSON.parse(replayed.resultJson) as DailyAnswerResult };
  }

  // 2) 预读：只做 404/409 分类，真正的归属/日期/状态守卫都在抢占语句内重查。
  const item = await db.prepare(LOAD_ITEM_SQL).bind(itemId).first<ItemRow>();
  if (!item || item.userId !== userId) return { ok: false, code: "not_found" };
  if (item.studyDate !== day) return { ok: false, code: "stale_day" };

  // 3) 已完成条目：不再接受任何作答，只回权威状态（纯读，无副作用）。
  if (item.status === "done") {
    const row = await readAuthOr404(db, itemId);
    if (!row) return { ok: false, code: "not_found" };
    return { ok: true, result: loserResult(row, eventId, "already_done") };
  }

  // 4) 首次作答：单语句条件 UPDATE 抢占 pending；胜者独占期内原子落库。
  if (item.status === "pending") {
    const correct = judge(input.action, normalizedAnswer, item.acceptedJson);
    const rating: CardRating = correct ? "Good" : "Again";
    const newStatus = correct ? "done" : "correction";
    const after = advanceCard(item.cardJson, rating, nowMs);
    const result: DailyAnswerResult = {
      eventId,
      applied: true,
      stage: "first",
      item: {
        id: item.id, senseId: item.senseId, term: item.term,
        meaning: item.meaning, status: newStatus,
      },
      correct,
      rating,
      starsAwarded: correct ? 1 : 0,
    };
    const claim = await db.prepare(CLAIM_FIRST_SQL)
      .bind(newStatus, eventId, itemId, eventId, userId, userId, day).run();
    if ((claim.meta.changes ?? 0) > 0) {
      // 唯一胜者：条目永远离开 pending，以下写入不受任何并发干扰。
      const stmts = [
        db.prepare(INSERT_FIRST_EVENT_SQL).bind(
          eventId, userId, item.senseId, itemId, input.action, normalizedAnswer,
          correct ? 1 : 0, nowMs, rating, item.cardJson, after.state, JSON.stringify(result),
        ),
        db.prepare(UPSERT_CARD_SQL).bind(userId, item.senseId, after.dueMs, after.state),
      ];
      // 星星/连击：答对 +1 星；答错 starDelta=0——仅更新 last_play_date/连击
      // （主代理裁决：与旧 /review、加练通道语义一致；全错日订正也是"学习了"，
      // 连击归零传达错误激励）。胜者独占期内无条件写入。
      stmts.push(db.prepare(UPSERT_STATS_SQL)
        .bind(userId, correct ? 1 : 0, day, dayStr(nowMs - 86_400_000)));
      await db.batch(stmts);
      return { ok: true, result };
    }
    // 落选：零写入；重读权威状态分类（含预读之后才翻篇的迟交竞态 → 409）。
    const row = await readAuthOr404(db, itemId);
    if (!row) return { ok: false, code: "not_found" };
    if (row.studyDate !== day) return { ok: false, code: "stale_day" };
    return { ok: true, result: loserResult(row, eventId, "first") };
  }

  // 5) 订正：答对→抢占推进到 done 后记录订正事件；答错/看答案→确认条目仍为
  //    correction 后记录失败订正事件。不碰卡片、星星与首次错误记录。
  const correct = judge(input.action, normalizedAnswer, item.acceptedJson);
  if (correct) {
    const claim = await db.prepare(CLAIM_CORRECTION_DONE_SQL)
      .bind(itemId, eventId, userId, userId, day).run();
    if ((claim.meta.changes ?? 0) > 0) {
      const result: DailyAnswerResult = {
        eventId,
        applied: true,
        stage: "correction",
        item: {
          id: item.id, senseId: item.senseId, term: item.term,
          meaning: item.meaning, status: "done",
        },
        correct: true,
        rating: null,
        starsAwarded: 0,
      };
      await db.prepare(INSERT_CORRECTION_EVENT_SQL).bind(
        eventId, userId, item.senseId, itemId, input.action, normalizedAnswer,
        1, nowMs, JSON.stringify(result),
      ).run();
      return { ok: true, result };
    }
  } else {
    const keep = await db.prepare(KEEP_CORRECTION_SQL)
      .bind(itemId, eventId, userId, userId, day).run();
    if ((keep.meta.changes ?? 0) > 0) {
      const result: DailyAnswerResult = {
        eventId,
        applied: true,
        stage: "correction",
        item: {
          id: item.id, senseId: item.senseId, term: item.term,
          meaning: item.meaning, status: "correction",
        },
        correct: false,
        rating: null,
        starsAwarded: 0,
      };
      await db.prepare(INSERT_CORRECTION_EVENT_SQL).bind(
        eventId, userId, item.senseId, itemId, input.action, normalizedAnswer,
        0, nowMs, JSON.stringify(result),
      ).run();
      return { ok: true, result };
    }
  }
  // 订正抢占落选（条目已被他人完成）：零写入，回权威状态。
  const row = await readAuthOr404(db, itemId);
  if (!row) return { ok: false, code: "not_found" };
  if (row.studyDate !== day) return { ok: false, code: "stale_day" };
  return { ok: true, result: loserResult(row, eventId, "correction") };
}
