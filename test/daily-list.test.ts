/// <reference types="@cloudflare/vitest-pool-workers" />
// 任务 5：POST /api/daily/open 生成并固定每日清单（上海自然日）。
// 建库方式参考 test/pool-admin.test.ts：SCHEMA_SQL 按 ; 拆分后 batch 执行；
// 教材/卡片/清单夹具直插对应表。每个用例独占 user id，避免
// UNIQUE(user_id, study_date) 跨用例相撞（测试在同一文件内共享数据库）。
// 时区场景用 vi.setSystemTime 控制 workerd 假时钟；其余用例用真实时钟，
// due_at 一律相对 Date.now() 构造，避免卡在午夜边界时偶发翻车。
import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { adminToken } from "./helpers";
import { SCHEMA_SQL } from "./schema";

declare module "cloudflare:test" {
  interface ProvidedEnv { DB: D1Database }
}

const db = env.DB;

beforeAll(async () => {
  const sql = SCHEMA_SQL;
  await db.batch(sql.split(";").map((s) => s.trim()).filter(Boolean).map((s) => db.prepare(s)));
});

afterEach(() => {
  vi.useRealTimers();
});

// —— 夹具辅助 ——

async function seedUser(id: number, name: string) {
  await db.prepare("INSERT INTO users (id, name, avatar) VALUES (?,?,'🧪')").bind(id, name).run();
}

async function seedUnit(id: number, bookOrder: number, unit: number) {
  await db.prepare("INSERT INTO curriculum_units VALUES (?,?,?,?,?)")
    .bind(id, `册${id}`, `测试第${id}册`, bookOrder, unit).run();
}

async function seedSense(senseId: string, term: string, meaning: string, accepted = [term]) {
  await db.prepare("INSERT INTO curriculum_senses VALUES (?,?,?,?)")
    .bind(senseId, term, meaning, JSON.stringify(accepted)).run();
}

async function linkSense(unitId: number, senseId: string, rowOrder: number) {
  await db.prepare("INSERT INTO curriculum_unit_senses VALUES (?,?,?)").bind(unitId, senseId, rowOrder).run();
}

async function openUnit(unitId: number) {
  await db.prepare("INSERT INTO pool_units VALUES (?)").bind(unitId).run();
}

async function seedCard(userId: number, senseId: string, dueAt: number) {
  await db.prepare("INSERT INTO user_cards VALUES (?,?,?,'{}')").bind(userId, senseId, dueAt).run();
}

async function listCountFor(userId: number) {
  return await db.prepare("SELECT COUNT(*) AS n FROM daily_lists WHERE user_id=?")
    .bind(userId).first<number>("n");
}

async function dbItemCount(userId: number, senseId?: string) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM daily_items i JOIN daily_lists h ON h.id = i.list_id
     WHERE h.user_id = ? ${senseId ? "AND i.sense_id = ?" : ""}`
  ).bind(...(senseId ? [userId, senseId] : [userId])).first<number>("n");
  return row ?? 0;
}

interface OpenResult {
  day: string;
  limit: number;
  items: { id: number; senseId: string; term: string; meaning: string; status: string; accepted: string[] }[];
  emptyReason?: string;
}

const openDaily = (userId: number) =>
  SELF.fetch("https://example.com/api/daily/open", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });

async function openJson(userId: number): Promise<OpenResult> {
  const res = await openDaily(userId);
  expect(res.status, `userId=${userId} 应返回 200`).toBe(200);
  return await res.json<OpenResult>();
}

describe("每日清单 POST /api/daily/open", () => {
  it("参数不完整返回 400，用户不存在返回 404 且不写清单", async () => {
    const bad = await SELF.fetch("https://example.com/api/daily/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    expect(bad.status).toBe(400);
    for (const body of [{}, { userId: 0 }, { userId: 1.5 }, { userId: "1" }]) {
      const res = await SELF.fetch("https://example.com/api/daily/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await openDaily(424242)).status).toBe(404);
    expect(await listCountFor(424242)).toBe(0);
  });

  it("空池并发打开只生成一份空清单；当天加单元不变，上海次日才重新生成", async () => {
    const u = 201;
    await seedUser(u, "空池并发");
    vi.useFakeTimers();
    // 上海 2026-11-22 10:30 = UTC 2026-11-21 02:30：断言 day 用上海日期而非 UTC 日期。
    vi.setSystemTime(new Date("2026-11-22T10:30:00+08:00"));
    const [r1, r2] = await Promise.all([openJson(u), openJson(u)]);
    for (const r of [r1, r2]) {
      expect(r.day).toBe("2026-11-22");
      expect(r.limit).toBe(10);
      expect(r.items).toEqual([]);
      expect(r.emptyReason).toBe("no_open_units");
    }
    expect(await listCountFor(u)).toBe(1); // 两台设备并发也只有一份清单头

    // 当天开放单元：当日清单已固定，仍为空
    await seedUnit(40, 1, 1);
    await seedSense("s-empty@1", "emptyword", "空池词");
    await linkSense(40, "s-empty@1", 1);
    await openUnit(40);
    const r3 = await openJson(u);
    expect(r3.day).toBe("2026-11-22");
    expect(r3.items).toEqual([]);

    // 上海次日：重新生成，纳入新开放单元的新词
    vi.setSystemTime(new Date("2026-11-23T09:00:00+08:00"));
    const r4 = await openJson(u);
    expect(r4.day).toBe("2026-11-23");
    expect(r4.items.map((i) => i.senseId)).toEqual(["s-empty@1"]);
    expect(r4.emptyReason).toBeUndefined();
    expect(await listCountFor(u)).toBe(2); // 一天一份
  });

  it("6 张到期卡加新词补齐配额 10：复习在前，新词按册/单元/行序", async () => {
    const u = 202;
    await seedUser(u, "补齐");
    await seedUnit(41, 2, 1);
    for (let i = 1; i <= 6; i++) {
      await seedSense(`s-fill${i}@1`, `fill${i}`, `补词${i}`);
      await linkSense(41, `s-fill${i}@1`, i);
    }
    await openUnit(41);
    const now = Date.now();
    // 6 张到期卡：s-due0 逾期最久 …… s-due5 最近（挂在开放单元内，满足池过滤；
    // 均有卡 → 不进新词池，不影响下面 4 个补位新词的断言）
    for (let i = 0; i < 6; i++) {
      await seedSense(`s-due${i}@1`, `due${i}`, `到期词${i}`, [`due${i}`, `due-${i}`]);
      await linkSense(41, `s-due${i}@1`, 6 + i);
      await seedCard(u, `s-due${i}@1`, now - (6 - i) * 3_600_000);
    }
    const r = await openJson(u);
    expect(r.limit).toBe(10);
    expect(r.items).toHaveLength(10);
    expect(r.items.slice(0, 6).map((i) => i.senseId))
      .toEqual(["s-due0@1", "s-due1@1", "s-due2@1", "s-due3@1", "s-due4@1", "s-due5@1"]);
    expect(r.items.slice(6).map((i) => i.senseId))
      .toEqual(["s-fill1@1", "s-fill2@1", "s-fill3@1", "s-fill4@1"]); // 只补 4 个，行序小的优先
    expect(r.emptyReason).toBeUndefined();
    expect(r.items[0]).toEqual({
      id: expect.any(Number),
      senseId: "s-due0@1",
      term: "due0",
      meaning: "到期词0",
      status: "pending",
      accepted: ["due0", "due-0"],
    });
    // 落库 kind：前 6 条 due、后 4 条 new
    const kinds = await db.prepare(
      `SELECT i.kind FROM daily_items i JOIN daily_lists h ON h.id = i.list_id
       WHERE h.user_id = ? ORDER BY i.position`
    ).bind(u).all<{ kind: string }>();
    expect(kinds.results.map((x) => x.kind))
      .toEqual(["due", "due", "due", "due", "due", "due", "new", "new", "new", "new"]);
  });

  it("12 张到期只取逾期最早的 10 张，同时到期按 sense_id 稳定排序", async () => {
    const u = 203;
    await seedUser(u, "截断");
    await seedUnit(52, 12, 1); // 到期卡统一挂在开放单元内，满足池过滤
    await openUnit(52);
    const now = Date.now();
    let row = 0;
    for (let i = 0; i < 8; i++) {
      await seedSense(`s-dist${i}@1`, `dist${i}`, `递到词${i}`);
      await linkSense(52, `s-dist${i}@1`, ++row);
      await seedCard(u, `s-dist${i}@1`, now - (20 - i) * 3_600_000);
    }
    // 两张同一时刻到期的平手卡，sense_id 字典序决定先后
    await seedSense("s-tieA@1", "tieA", "平手甲");
    await seedSense("s-tieB@1", "tieB", "平手乙");
    await linkSense(52, "s-tieA@1", ++row);
    await linkSense(52, "s-tieB@1", ++row);
    await seedCard(u, "s-tieA@1", now - 2 * 3_600_000);
    await seedCard(u, "s-tieB@1", now - 2 * 3_600_000);
    // 最新到期的两张应被裁掉
    await seedSense("s-cutA@1", "cutA", "裁甲");
    await seedSense("s-cutB@1", "cutB", "裁乙");
    await linkSense(52, "s-cutA@1", ++row);
    await linkSense(52, "s-cutB@1", ++row);
    await seedCard(u, "s-cutA@1", now - 3_600_000);
    await seedCard(u, "s-cutB@1", now - 3_600_000);
    const r = await openJson(u);
    expect(r.items).toHaveLength(10);
    expect(r.items.map((i) => i.senseId)).toEqual([
      "s-dist0@1", "s-dist1@1", "s-dist2@1", "s-dist3@1", "s-dist4@1",
      "s-dist5@1", "s-dist6@1", "s-dist7@1", "s-tieA@1", "s-tieB@1",
    ]);
    expect(await dbItemCount(u, "s-cutA@1")).toBe(0);
    expect(await dbItemCount(u, "s-cutB@1")).toBe(0);
  });

  it("只有未来卡时不按新词补位：清单为空并说明原因", async () => {
    const u = 204;
    await seedUser(u, "未来");
    await seedUnit(42, 3, 1);
    await seedSense("s-future1@1", "future1", "未来词1");
    await seedSense("s-future2@1", "future2", "未来词2");
    await linkSense(42, "s-future1@1", 1);
    await linkSense(42, "s-future2@1", 2);
    await openUnit(42);
    const now = Date.now();
    await seedCard(u, "s-future1@1", now + 3 * 86_400_000);
    await seedCard(u, "s-future2@1", now + 5 * 86_400_000);
    const r = await openJson(u);
    expect(r.items).toEqual([]);
    expect(r.emptyReason).toBe("no_words_today");
  });

  it("上海日末界定到期：当日 23:59:59.999 含，次日 00:00 不含", async () => {
    const u = 205;
    await seedUser(u, "日末");
    await seedUnit(43, 4, 1);
    await openUnit(43);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-25T09:00:00+08:00"));
    const dayEnd = Date.parse("2026-11-25T23:59:59.999+08:00");
    // 三张卡都挂在开放单元 43 内（满足池过滤）；均有卡 → 新词池仍为空
    await seedSense("s-tonight@1", "tonight", "今晚到期");
    await seedSense("s-boundary@1", "boundary", "日末边界");
    await seedSense("s-tomorrow@1", "tomorrow", "明天到期");
    await linkSense(43, "s-tonight@1", 1);
    await linkSense(43, "s-boundary@1", 2);
    await linkSense(43, "s-tomorrow@1", 3);
    // 当天晚些时候（晚于“现在”）到期也算到期
    await seedCard(u, "s-tonight@1", Date.parse("2026-11-25T22:00:00+08:00"));
    await seedCard(u, "s-boundary@1", dayEnd);
    await seedCard(u, "s-tomorrow@1", dayEnd + 1);
    const r = await openJson(u);
    expect(r.day).toBe("2026-11-25");
    expect(r.items.map((i) => i.senseId)).toEqual(["s-tonight@1", "s-boundary@1"]); // 按 due_at 升序
  });

  it("到期卡只选共享池内的词义：池外单元的到期卡不选，跨开放单元只算一次", async () => {
    const u = 213;
    await seedUser(u, "池内到期");
    // 开放单元 51：一个到期词、一个新词，外加一个同时在两个开放单元的到期词
    await seedUnit(51, 12, 1);
    await seedSense("s-pool-due@1", "pooldue", "池内到期词");
    await seedSense("s-pool-new@1", "poolnew", "池内新词");
    await seedSense("s-dual-due@1", "dualdue", "双单元到期词");
    await linkSense(51, "s-pool-due@1", 1);
    await linkSense(51, "s-pool-new@1", 2);
    await linkSense(51, "s-dual-due@1", 3);
    // 封闭单元 53（从未入池）：其中的到期卡逾期最久也不得入选
    await seedUnit(53, 13, 1);
    await seedSense("s-closed-due@1", "closeddue", "池外到期词");
    await linkSense(53, "s-closed-due@1", 1);
    // 第二个开放单元 54 同样含 s-dual-due：同一词义到期只占一个名额
    await seedUnit(54, 14, 1);
    await linkSense(54, "s-dual-due@1", 1);
    await openUnit(51);
    await openUnit(54);
    const now = Date.now();
    await seedCard(u, "s-pool-due@1", now - 3_600_000);
    await seedCard(u, "s-closed-due@1", now - 7_200_000); // 若未过滤池，它会排第一
    await seedCard(u, "s-dual-due@1", now - 1_800_000);
    const r = await openJson(u);
    // 到期按 due_at 升序（池外卡被过滤），新词按册/单元/行序补位
    expect(r.items.map((i) => i.senseId))
      .toEqual(["s-pool-due@1", "s-dual-due@1", "s-pool-new@1"]);
    expect(await dbItemCount(u, "s-closed-due@1")).toBe(0);
    expect(await dbItemCount(u, "s-dual-due@1")).toBe(1); // 跨开放单元不重复计名额
  });

  it("同一词义出现在两个开放单元只占一个名额", async () => {
    const u = 206;
    await seedUser(u, "去重");
    await seedUnit(44, 5, 1);
    await seedUnit(45, 6, 1);
    await seedSense("s-dup@1", "dupword", "重复词");
    await linkSense(44, "s-dup@1", 1);
    await linkSense(45, "s-dup@1", 1);
    await seedSense("s-only44@1", "only44", "独词44");
    await seedSense("s-only45@1", "only45", "独词45");
    await linkSense(44, "s-only44@1", 2);
    await linkSense(45, "s-only45@1", 2);
    await openUnit(44);
    await openUnit(45);
    const r = await openJson(u);
    // 去重保留首次出现位置（册序小的单元 44）
    expect(r.items.map((i) => i.senseId)).toEqual(["s-dup@1", "s-only44@1", "s-only45@1"]);
    expect(await dbItemCount(u, "s-dup@1")).toBe(1);
  });

  it("共用单元但历史不同：两人清单不同，各自只读自己的卡", async () => {
    const u1 = 207, u2 = 208;
    await seedUser(u1, "兄弟甲");
    await seedUser(u2, "兄弟乙");
    await seedUnit(46, 7, 1);
    await seedSense("s-ownA@1", "owna", "甲的到期卡");
    await seedSense("s-ownB@1", "ownb", "乙的到期卡");
    await seedSense("s-fresh@1", "fresh", "共同新词");
    await linkSense(46, "s-ownA@1", 1);
    await linkSense(46, "s-ownB@1", 2);
    await linkSense(46, "s-fresh@1", 3);
    await openUnit(46);
    const now = Date.now();
    await seedCard(u1, "s-ownA@1", now - 7_200_000);
    await seedCard(u2, "s-ownB@1", now - 7_200_000);
    const [r1, r2] = [await openJson(u1), await openJson(u2)];
    // 甲的到期卡是乙的新词，反之亦然：到期判定只读本人卡片，新词来自共享池
    expect(r1.items.map((i) => i.senseId)).toEqual(["s-ownA@1", "s-ownB@1", "s-fresh@1"]);
    expect(r2.items.map((i) => i.senseId)).toEqual(["s-ownB@1", "s-ownA@1", "s-fresh@1"]);
    expect(r1.items.map((i) => i.id)).not.toEqual(r2.items.map((i) => i.id));
  });

  it("并发首次打开得到同一份清单：相同条目 ID，只落一份头", async () => {
    const u = 209;
    await seedUser(u, "并发");
    await seedUnit(47, 8, 1);
    for (let i = 1; i <= 5; i++) {
      await seedSense(`s-race-new${i}@1`, `racenew${i}`, `并发新词${i}`);
      await linkSense(47, `s-race-new${i}@1`, i);
    }
    const now = Date.now();
    for (let i = 1; i <= 3; i++) {
      await seedSense(`s-race-due${i}@1`, `racedue${i}`, `并发到期${i}`);
      await linkSense(47, `s-race-due${i}@1`, 5 + i); // 挂开放单元满足池过滤；有卡不进新词池
      await seedCard(u, `s-race-due${i}@1`, now - i * 3_600_000);
    }
    await openUnit(47);
    const rs = await Promise.all([openJson(u), openJson(u), openJson(u)]);
    expect(rs[0].items).toEqual(rs[1].items);
    expect(rs[1].items).toEqual(rs[2].items);
    expect(rs[0].items).toHaveLength(8);
    expect(await listCountFor(u)).toBe(1);
    expect(await dbItemCount(u)).toBe(8);
  });

  it("配额中途更改不影响已固定的当日清单", async () => {
    const u = 210;
    await seedUser(u, "配额");
    await seedUnit(48, 9, 1);
    // 16 个新词：即使配额 20 也足够，排除“因词不够而仍是 15”的假通过
    for (let i = 1; i <= 16; i++) {
      const sid = `s-quota${String(i).padStart(2, "0")}@1`;
      await seedSense(sid, `quota${i}`, `配额词${i}`);
      await linkSense(48, sid, i);
    }
    await openUnit(48);
    const putQuota = (limit: number) =>
      SELF.fetch("https://example.com/api/admin/quota", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-admin-token": adminToken },
        body: JSON.stringify({ userId: u, limit }),
      });
    expect((await putQuota(15)).status).toBe(200);
    const r1 = await openJson(u);
    expect(r1.limit).toBe(15);
    expect(r1.items).toHaveLength(15);
    expect((await putQuota(20)).status).toBe(200); // 生成后中途上调
    const r2 = await openJson(u);
    expect(r2.limit).toBe(15); // 仍按生成时固化的配额
    expect(r2.items.map((i) => i.id)).toEqual(r1.items.map((i) => i.id));
  });

  it("昨日清单中未作答的新词今天仍可再选", async () => {
    const u = 211;
    await seedUser(u, "昨日新词");
    await seedUnit(49, 10, 1);
    await seedSense("s-again@1", "againword", "再选词");
    await linkSense(49, "s-again@1", 1);
    await openUnit(49);
    // 直插"昨天"的清单：条目仍 pending，且从未作答（无 user_cards 历史）
    const yesterday = new Date(Date.now() - 86_400_000)
      .toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
    const head = await db.prepare(
      "INSERT INTO daily_lists (user_id, study_date, daily_limit, generation_token) VALUES (?,?,10,'tok-yesterday') RETURNING id"
    ).bind(u, yesterday).first<{ id: number }>();
    await db.prepare(
      "INSERT INTO daily_items (list_id, sense_id, position, kind) VALUES (?,'s-again@1',0,'new')"
    ).bind(head!.id).run();
    const r = await openJson(u);
    expect(r.day).not.toBe(yesterday); // 今天生成的是新清单
    expect(r.items.map((i) => i.senseId)).toEqual(["s-again@1"]);
    expect(r.items[0].status).toBe("pending");
  });

  it("已生成清单再次打开返回条目最新状态", async () => {
    const u = 212;
    await seedUser(u, "状态");
    await seedUnit(50, 11, 1);
    await seedSense("s-status@1", "statusword", "状态词");
    await linkSense(50, "s-status@1", 1);
    await openUnit(50);
    const r1 = await openJson(u);
    expect(r1.items[0].status).toBe("pending");
    await db.prepare(
      "UPDATE daily_items SET status = 'done' WHERE sense_id = 's-status@1' AND list_id IN (SELECT id FROM daily_lists WHERE user_id = ?)"
    ).bind(u).run();
    const r2 = await openJson(u);
    expect(r2.items.map((i) => i.id)).toEqual(r1.items.map((i) => i.id));
    expect(r2.items[0].status).toBe("done");
  });
});
