// 每日清单（POST /api/daily/open）：为单个孩子生成并固定当天清单。
// 以上海自然日为界，同一 (user, study_date) 只允许存在一份清单。
//
// 并发契约（计划 Review Focus #3：两台设备首次打开、甚至拿到空清单，
// 也只能生成一份）：头、条目、回读全部放进同一个 D1 batch（单事务）：
//   1. INSERT ... ON CONFLICT(user_id, study_date) DO NOTHING 抢占唯一位；
//   2. 条目 INSERT...SELECT 以 generation_token 匹配为闸门——只有真正创建
//      这份头的令牌才匹配得到行，落选方一条都不写（持久化零条目）；
//   3. 同事务内回读头与条目，胜方与落选方返回同一份数据。
//
// 选词规则（Global Constraints + 规格裁决"只选共享池内的词"）：
//   到期卡（user_cards.due_at ≤ 上海当日 23:59:59.999，当日之内到期都算）
//   须仍位于共享池开放单元（EXISTS 判定；词义同时在多个开放单元也只算一次），
//   按 due_at 升序、平手按 sense_id；不足配额再从开放单元补"无本人
//   user_cards 历史"的新词，按 book_order → unit → row_order；同一词义跨
//   单元重复只占一个名额（保留按教材顺序的首次出现位置）。
//   配额在生成时读取并随清单头固化，之后修改配额不影响已生成清单。

const SHANGHAI_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" });

// en-CA 输出 YYYY-MM-DD。kid.ts 的 applyReviewStats 复用本函数。
export function dayStr(ms: number): string {
  return SHANGHAI_DATE.format(new Date(ms));
}

// 孩子首页和家长后台共用。i 是清单 LEFT JOIN 的条目，空清单的各项计数均为 0。
export const DAILY_ITEM_COUNTS_SQL = `
  COUNT(i.id) AS total,
  COUNT(CASE WHEN i.status = 'done' THEN 1 END) AS done,
  COUNT(CASE WHEN i.status = 'correction' THEN 1 END) AS correction,
  COUNT(CASE WHEN i.status = 'pending' THEN 1 END) AS pending`;

// 上海当日 23:59:59.999 的 epoch ms。
// Asia/Shanghai 固定 UTC+8（1991 年后无夏令时），用带 +08:00 偏移的 ISO 串
// 解析，避免手写偏移算术。
function dayEndMs(day: string): number {
  return Date.parse(`${day}T23:59:59.999+08:00`);
}

export interface DailyItem {
  id: number;
  senseId: string;
  term: string;
  meaning: string;
  status: string;
}

export interface DailyOpenResult {
  day: string;
  limit: number;
  items: DailyItem[];
  emptyReason?: string;
}

// 选词 + 写条目（一条语句完成）：picked 按
// (复习在前, due_at, sense_id / book_order, unit, row_order, sense_id)
// 总序排序并截断到配额，再按同一顺序写 0 起始的 position。
// 语句末尾 WHERE 的 generation_token 是并发抢占闸门：本请求没有抢到
// 清单头时匹配不到任何行，一条条目都不插入。
// 参数：?1 userId  ?2 配额  ?3 study_date  ?4 上海日末 epoch ms  ?5 生成令牌
const GENERATE_ITEMS_SQL = `
WITH picked AS (
  SELECT sense_id, kind, is_new, k1, k2, k3, sid FROM (
    -- 规格裁决："只选共享池内的词"同样约束到期分支——卡须仍位于开放单元。
    -- EXISTS 保证一张卡只出一行（词义跨多个开放单元也不重复计名额）。
    SELECT c.sense_id, 'due' AS kind, 0 AS is_new,
           c.due_at AS k1, 0 AS k2, 0 AS k3, c.sense_id AS sid
    FROM user_cards c
    WHERE c.user_id = ?1 AND c.due_at <= ?4
      AND EXISTS (
        SELECT 1 FROM curriculum_unit_senses x
        JOIN pool_units p ON p.unit_id = x.unit_id
        WHERE x.sense_id = c.sense_id
      )
    UNION ALL
    SELECT sense_id, 'new', 1, book_order, unit, row_order, sense_id
    FROM (
      SELECT x.sense_id, cu.book_order, cu.unit, x.row_order,
             ROW_NUMBER() OVER (
               PARTITION BY x.sense_id
               ORDER BY cu.book_order, cu.unit, x.row_order, x.sense_id
             ) AS rn
      FROM curriculum_unit_senses x
      JOIN pool_units p ON p.unit_id = x.unit_id
      JOIN curriculum_units cu ON cu.id = x.unit_id
      WHERE NOT EXISTS (
        SELECT 1 FROM user_cards uc
        WHERE uc.user_id = ?1 AND uc.sense_id = x.sense_id
      )
    )
    WHERE rn = 1
  )
  ORDER BY is_new, k1, k2, k3, sid
  LIMIT ?2
)
INSERT INTO daily_items (list_id, sense_id, position, kind)
SELECT h.id, p.sense_id,
       ROW_NUMBER() OVER (ORDER BY p.is_new, p.k1, p.k2, p.k3, p.sid) - 1,
       p.kind
FROM daily_lists h, picked p
WHERE h.user_id = ?1 AND h.study_date = ?3 AND h.generation_token = ?5`;

export async function openDailyList(
  db: D1Database,
  userId: number,
  nowMs: number,
): Promise<DailyOpenResult> {
  const day = dayStr(nowMs);
  const dayEnd = dayEndMs(day);
  // 配额只在生成时读取；清单头一旦创建即固化，之后改配额只影响后续日期。
  const quota = (await db.prepare(
    "SELECT COALESCE((SELECT daily_limit FROM user_quotas WHERE user_id = ?1), 10) AS quota"
  ).bind(userId).first<{ quota: number }>())?.quota ?? 10;
  const token = crypto.randomUUID();

  const batchResults = await db.batch([
    // 1) 抢占 (user, day) 唯一位；落选方被 UNIQUE 约束静默跳过。
    db.prepare(
      `INSERT INTO daily_lists (user_id, study_date, daily_limit, generation_token)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (user_id, study_date) DO NOTHING`
    ).bind(userId, day, quota, token),
    // 2) 条目：令牌不匹配（没抢到头）时 WHERE 过滤掉全部行 → 零条目。
    db.prepare(GENERATE_ITEMS_SQL).bind(userId, quota, day, dayEnd, token),
    // 3)/4) 同事务回读：无论本请求是否胜出，返回的都是已提交的那一份。
    db.prepare(
      "SELECT id, daily_limit FROM daily_lists WHERE user_id = ?1 AND study_date = ?2"
    ).bind(userId, day),
    db.prepare(
      `SELECT i.id, i.sense_id AS senseId, s.term, s.meaning, i.status
       FROM daily_items i
       JOIN daily_lists h ON h.id = i.list_id
       JOIN curriculum_senses s ON s.sense_id = i.sense_id
       WHERE h.user_id = ?1 AND h.study_date = ?2
       ORDER BY i.position`
    ).bind(userId, day),
    // 5) 空清单时区分"未开放单元"与"暂无可学词"。
    db.prepare("SELECT COUNT(*) AS n FROM pool_units"),
  ]);

  const header = (batchResults[2].results as Array<{ id: number; daily_limit: number }>)[0];
  if (!header) {
    // 路由已验证用户存在，步骤 1 要么插入要么撞唯一约束；不可达，防御性报错。
    throw new Error(`daily: 清单头缺失 user=${userId} day=${day}`);
  }
  const items = batchResults[3].results as DailyItem[];

  const result: DailyOpenResult = { day, limit: header.daily_limit, items };
  if (items.length === 0) {
    const pool = (batchResults[4].results as Array<{ n: number }>)[0];
    result.emptyReason = (pool?.n ?? 0) === 0 ? "no_open_units" : "no_words_today";
  }
  return result;
}
