/// <reference types="@cloudflare/vitest-pool-workers" />
// 任务 8：换库演练与切换 —— 端到端夹具
// （docs/superpowers/plans/2026-11-22-shared-pool-fsrs.md 任务 8）。
//
// 与 test/curriculum-migration.test.ts 互补：那边测表结构与 upsert 幂等（表级语义），
// 这里按真实切换时间线走端到端流程：
//   ① 旧世界（旧进度：reps/星星/连击/错拼/覆盖）
//   ② 一次性切换（0003：建新表 + 清零旧个人状态）
//   ③ 零状态断言：账号保留、旧进度/星星/连击/错词/共享池全空、空池打开 no_open_units
//   ④ 装载教材（对账交接验收数 52 单元 / 722 词义 / 903 关联）+ 加入共享池同一单元
//   ⑤ 换库当日清单仍固定为空（清单一次性契约，加池次日生效）
//   ⑥ D2 两人各自首份清单全为新词（无到期卡——卡被清/不存在）
//   ⑦ 哥哥错、弟弟对（同一词义）：卡片分叉（due_at/状态不同）、评级各自
//   ⑧ 再次导入教材（幂等 upsert）：新进度不被抹掉、账号不变、两次导入无重复
//   ⑨ D3 上海次日打开：到期复习排前 + 新词补位；昨日记录原样保留
//
// 装载路径与生产等价：scripts/build-curriculum-sql.mjs 的 curriculumStatements(books.json)
// 生成幂等 upsert 语句 → D1 batch（生产即 wrangler d1 execute 同一生成器的产物）。
// 0003 的 cutover 段是一次性迁移：生产由 d1_migrations 记录已应用版本保证只跑一次，
// 本测试同样只应用一次；重复导入教材 = 幂等 upsert，不碰个人状态表（账本 Ruling）。
//
// 夹具选全量 data/curriculum/books.json（而非 hardcode 小样本）：首学清单与对账断言
// 直接钉在验收数上，贴近真实切换；单次装载约 1.7k 条幂等语句，本地 miniflare D1 可承受。
//
// RED 检出点（checkbox 2）：装载教材一步被关闭时，夹具必须在「教材对账」断言处失败
// （0 ≠ 52/722/903）——证明夹具能检出未装载教材、不是恒真；接通完整迁移+装载流程后全绿。
//
// 时钟用 vi.setSystemTime 控制 workerd 假时钟（模式同 test/daily-list.test.ts）；
// 时点取上海上午（UTC 仍是前一天），钉住「上海日界 ≠ UTC 日界」。
import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { adminToken } from "./helpers";
import { LEGACY_SCHEMA_SQL, CUTOVER_SQL } from "./schema";
// @ts-expect-error 离线 Node 生成器无类型声明
import { curriculumStatements } from "../scripts/build-curriculum-sql.mjs";
import books from "../data/curriculum/books.json";

declare module "cloudflare:test" {
  interface ProvidedEnv { DB: D1Database }
}

const db = env.DB as D1Database;

// 交接验收数（与 data/curriculum/books.json 对账；未装载教材时为 0 → RED 检出点）
const ACCEPT_UNITS = 52;
const ACCEPT_SENSES = 722;
const ACCEPT_LINKS = 903;

// 演练时间线（上海日期）：D1 换库日、D2 首学日、D3 复习日
const D1 = "2026-11-22";
const D2 = "2026-11-23";
const D3 = "2026-11-24";

async function run(sql: string) {
  const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
  if (statements.length) await db.batch(statements.map((s) => db.prepare(s)));
}

async function count(table: string): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>("n")) ?? -1;
}

const userIdByName = (name: string) =>
  db.prepare("SELECT id FROM users WHERE name = ?").bind(name).first<number>("id");

// 生产装载路径：Node 侧生成器产出幂等 upsert → batch（与 wrangler d1 execute 产物等价）
const loadCurriculum = () =>
  db.batch((curriculumStatements(books) as string[]).map((s) => db.prepare(s)));

// —— 请求辅助 ——

interface OpenItem { id: number; senseId: string; term: string; meaning: string; status: string }
interface OpenResult { day: string; limit: number; items: OpenItem[]; emptyReason?: string }

const openJson = async (userId: number): Promise<OpenResult> => {
  const res = await SELF.fetch("https://example.com/api/daily/open", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  expect(res.status, `open userId=${userId} 应返回 200`).toBe(200);
  return await res.json<OpenResult>();
};

interface AnswerView {
  eventId: string;
  applied: boolean;
  stage: string;
  item: { id: number; senseId: string; term: string; meaning: string; status: string };
  correct: boolean | null;
  rating: string | null;
  starsAwarded: number;
}

const answerJson = async (body: Record<string, unknown>): Promise<AnswerView> => {
  const res = await SELF.fetch("https://example.com/api/daily/answer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status, `answer ${String(body.eventId)} 应返回 200`).toBe(200);
  return await res.json<AnswerView>();
};

// 某孩子某天清单的条目（按 position，落库形态）
async function itemsFor(userId: number, day: string) {
  const rows = await db.prepare(
    `SELECT i.sense_id AS senseId, i.kind, i.status, i.position
     FROM daily_items i JOIN daily_lists h ON h.id = i.list_id
     WHERE h.user_id = ? AND h.study_date = ?
     ORDER BY i.position`
  ).bind(userId, day).all<{ senseId: string; kind: string; status: string; position: number }>();
  return rows.results;
}

// 换库不得触碰的个人/共享状态快照（按主键排序保证比较稳定）
const SNAPSHOTS: Array<[string, string]> = [
  ["users", "id"],
  ["pool_units", "unit_id"],
  ["user_quotas", "user_id"],
  ["user_cards", "user_id, sense_id"],
  ["daily_lists", "id"],
  ["daily_items", "id"],
  ["answer_events", "event_id"],
  ["user_stats", "user_id"],
];

const snapshotState = () =>
  Promise.all(SNAPSHOTS.map(async ([t, order]) =>
    (await db.prepare(`SELECT * FROM ${t} ORDER BY ${order}`).all()).results));

beforeAll(async () => {
  // 旧世界 schema（0001/0002 等价物，预置账号：哥哥=1、弟弟=2）
  await run(LEGACY_SCHEMA_SQL);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("换库演练端到端（旧进度 → 一次性切换 → 装载 → 首学 → 再导入 → 次日）", () => {
  it("清零不删号；装载后两人从零开始；兄弟卡片分叉；再导入幂等；次日复习+新词", async () => {
    // —— ① 旧世界：旧进度（reps/星星/连击/错拼/覆盖）——
    await run(`
      INSERT INTO user_word_state(user_id,word_id,reps,interval_days,due_at,lapses,last_reviewed_at)
        SELECT id,1,3,1,42,1,42 FROM users;
      INSERT INTO user_unit_word_seen(user_id,unit_id,word_id,first_seen_at)
        SELECT id,1,1,42 FROM users;
      INSERT INTO wrong_answer_events(user_id,word_id,answer,source,created_at)
        SELECT id,1,'appel','daily',42 FROM users;
      INSERT INTO user_stats(user_id,stars,streak_days,last_play_date)
        VALUES (1,37,6,'2026-11-21'),(2,12,3,'2026-11-20');
    `);
    const geger = await userIdByName("哥哥");
    const didi = await userIdByName("弟弟");
    expect(geger, "哥哥账号应存在").toBeTruthy();
    expect(didi, "弟弟账号应存在").toBeTruthy();
    const usersBefore = (await db.prepare("SELECT * FROM users ORDER BY id").all()).results;

    // —— ② 一次性切换（0003：建新表 + 清零旧个人状态；生产由 d1_migrations 保证只跑一次）——
    await run(CUTOVER_SQL);

    // —— ③ 零状态：账号保留；旧个人状态/星星/连击/错词/共享池全空 ——
    expect((await db.prepare("SELECT * FROM users ORDER BY id").all()).results)
      .toEqual(usersBefore);
    for (const t of [
      "user_word_state", "user_unit_word_seen", "wrong_answer_events",
      "user_stats", "pool_units", "user_cards",
    ]) {
      expect(await count(t), `换库后 ${t} 应为空`).toBe(0);
    }

    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${D1}T10:30:00+08:00`)); // UTC 仍是 11-21：钉住上海日界

    // 首页零状态（生产只读接口）：星星/连击/错词/共享池全空、无当日清单
    const homeJson = async (userId: number) => {
      const res = await SELF.fetch(`https://example.com/api/home?user_id=${userId}`);
      expect(res.status, `home userId=${userId} 应返回 200`).toBe(200);
      return await res.json<{
        stars: number; streak_days: number; daily: unknown; mistakeCount: number; units: unknown[];
      }>();
    };
    for (const [name, u] of [["哥哥", geger], ["弟弟", didi]] as const) {
      const h = await homeJson(u as number);
      expect(h.stars, `${name} 星星应清零`).toBe(0);
      expect(h.streak_days, `${name} 连续学习天数应清零`).toBe(0);
      expect(h.daily, `${name} 无当日清单`).toBeNull();
      expect(h.mistakeCount, `${name} 错词本应清零`).toBe(0);
      expect(h.units, "共享池应为空").toEqual([]);
    }

    // —— ③b 空池打开：无任务并标明原因（当日清单被固定）——
    for (const u of [geger, didi]) {
      const empty = await openJson(u as number);
      expect(empty.day, "上海日界：UTC 仍是 11-21，day 应为上海日期").toBe(D1);
      expect(empty.items).toEqual([]);
      expect(empty.emptyReason, "空池打开应说明 no_open_units").toBe("no_open_units");
    }

    // —— ④ 装载教材 + 加入共享池同一单元 ——
    // RED 轮曾把下一行注释、在「未装载教材」状态下运行：夹具按预期在对账断言失败
    // （expected 0 to be 52），证明它能检出未装载教材、不是恒真；GREEN 轮接通完整
    // 迁移+装载流程（0003 切换已于②应用，此处补上教材装载）。
    await loadCurriculum();
    expect(await count("curriculum_units"), "教材对账：单元数（未装载教材时为 0）").toBe(ACCEPT_UNITS);
    expect(await count("curriculum_senses"), "教材对账：词义数（未装载教材时为 0）").toBe(ACCEPT_SENSES);
    expect(await count("curriculum_unit_senses"), "教材对账：关联数（未装载教材时为 0）").toBe(ACCEPT_LINKS);
    const unitId = await db.prepare(
      "SELECT id FROM curriculum_units ORDER BY book_order, unit, id LIMIT 1"
    ).first<number>("id");
    expect(unitId, "教材应有单元可入池").toBeTruthy();
    expect((await SELF.fetch("https://example.com/api/admin/pool", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": adminToken },
      body: JSON.stringify({ unitIds: [unitId as number] }),
    })).status, "加入共享池应成功").toBe(200);

    // —— ⑤ 换库当日：清单已固定为空——加池不回填当日（一次性契约，次日才生效）——
    const pinned = await openJson(geger as number);
    expect(pinned.day).toBe(D1);
    expect(pinned.items, "当日已固定的空清单不回填").toEqual([]);

    // —— ⑥ D2：两人各自首份清单全为新词（卡被清/不存在，无到期）——
    vi.setSystemTime(new Date(`${D2}T09:00:00+08:00`));
    expect(await count("user_cards"), "切换后不应存在任何卡片").toBe(0);
    const rG = await openJson(geger as number);
    const rD = await openJson(didi as number);
    expect(rG.day).toBe(D2);
    expect(rD.day).toBe(D2);
    expect(rG.limit, "默认配额 10").toBe(10);
    expect(rG.items.length, "哥哥首份清单应有词").toBeGreaterThan(0);
    expect(rD.items.length, "弟弟首份清单应有词").toBeGreaterThan(0);
    const kindsG = await itemsFor(geger as number, D2);
    const kindsD = await itemsFor(didi as number, D2);
    expect(kindsG.every((i) => i.kind === "new"), "哥哥首份清单应全为新词").toBe(true);
    expect(kindsD.every((i) => i.kind === "new"), "弟弟首份清单应全为新词").toBe(true);
    expect(rG.items.map((i) => i.senseId), "同一单元从零开始：两人清单内容一致").toEqual(
      rD.items.map((i) => i.senseId),
    );

    // —— ⑦ 哥哥错、弟弟对（同一词义）：卡片分叉、评级各自 ——
    const sense = rG.items[0]!.senseId;
    expect(rD.items[0]!.senseId, "两人首词应相同（同一单元从零开始）").toBe(sense);
    vi.setSystemTime(new Date(`${D2}T09:05:00+08:00`));
    const accepted = JSON.parse(
      (await db.prepare("SELECT accepted_json FROM curriculum_senses WHERE sense_id = ?")
        .bind(sense).first<{ accepted_json: string }>())!.accepted_json,
    ) as string[];
    const wrong = await answerJson({
      userId: geger as number, itemId: rG.items[0]!.id,
      eventId: "evt-cutover-wrong", action: "spell", answer: "banana-x",
    });
    expect(wrong.applied).toBe(true);
    expect(wrong.stage).toBe("first");
    expect(wrong.rating, "哥哥答错应评 Again").toBe("Again");
    expect(wrong.correct).toBe(false);
    expect(wrong.starsAwarded, "答错不加星").toBe(0);
    expect(wrong.item.status, "答错条目进入订正").toBe("correction");
    const right = await answerJson({
      userId: didi as number, itemId: rD.items[0]!.id,
      eventId: "evt-cutover-right", action: "spell", answer: accepted[0]!,
    });
    expect(right.applied).toBe(true);
    expect(right.rating, "弟弟答对应评 Good").toBe("Good");
    expect(right.correct).toBe(true);
    expect(right.starsAwarded, "弟弟答对应得 1 星").toBe(1);
    expect(right.item.status, "答对条目完成").toBe("done");

    const cardOf = (userId: number) => db.prepare(
      "SELECT due_at, card_json FROM user_cards WHERE user_id = ? AND sense_id = ?",
    ).bind(userId, sense).first<{ due_at: number; card_json: string }>();
    const cardG = await cardOf(geger as number);
    const cardD = await cardOf(didi as number);
    expect(cardG, "哥哥应有自己的卡").toBeTruthy();
    expect(cardD, "弟弟应有自己的卡").toBeTruthy();
    expect(cardG!.due_at, "同一词义：兄弟到期时刻应不同（Again 立即重学 / Good 推进）")
      .not.toBe(cardD!.due_at);
    expect(cardG!.card_json, "同一词义：兄弟卡片状态应不同").not.toBe(cardD!.card_json);
    expect(await count("user_cards")).toBe(2);
    const evG = await db.prepare(
      "SELECT correct, rating FROM answer_events WHERE event_id = 'evt-cutover-wrong'",
    ).first<{ correct: number; rating: string }>();
    const evD = await db.prepare(
      "SELECT correct, rating FROM answer_events WHERE event_id = 'evt-cutover-right'",
    ).first<{ correct: number; rating: string }>();
    expect(evG).toMatchObject({ correct: 0, rating: "Again" });
    expect(evD).toMatchObject({ correct: 1, rating: "Good" });
    const statsD = await db.prepare(
      "SELECT stars, streak_days, last_play_date FROM user_stats WHERE user_id = ?",
    ).bind(didi as number).first<{ stars: number; streak_days: number; last_play_date: string }>();
    expect(statsD, "弟弟星星/连击应从零开始累计").toEqual({ stars: 1, streak_days: 1, last_play_date: D2 });
    const statsG = await db.prepare(
      "SELECT stars, streak_days, last_play_date FROM user_stats WHERE user_id = ?",
    ).bind(geger as number).first<{ stars: number; streak_days: number; last_play_date: string }>();
    expect(statsG, "哥哥答错（Again）也记学习日：星 0、连击续上（三通道一致裁决）")
      .toEqual({ stars: 0, streak_days: 1, last_play_date: D2 });

    // —— ⑧ 再次导入教材（幂等 upsert）：新进度不被抹掉、账号不变、无重复 ——
    const beforeImport = await snapshotState();
    await loadCurriculum();
    expect(await snapshotState(), "再次导入不得改动个人/共享状态").toEqual(beforeImport);
    expect(await count("curriculum_units"), "两次导入无重复：单元计数不变").toBe(ACCEPT_UNITS);
    expect(await count("curriculum_senses"), "两次导入无重复：词义计数不变").toBe(ACCEPT_SENSES);
    expect(await count("curriculum_unit_senses"), "两次导入无重复：关联计数不变").toBe(ACCEPT_LINKS);

    // —— ⑨ D3 上海次日打开：到期复习排前 + 新词补位；昨日记录原样保留 ——
    // （New→Good 产出 Learning 卡，默认 steps ['1m','10m']：弟弟 Good 卡 +10m 到期，
    //   哥哥 Again 卡 +1m 到期——次日两卡都到期，均以 kind='due' 排在清单首位。
    //   依据 test/fsrs.test.ts 已钉住的 ts-fsrs 6.0.0 默认调度行为。）
    vi.setSystemTime(new Date(`${D3}T09:00:00+08:00`));
    const r3G = await openJson(geger as number);
    const r3D = await openJson(didi as number);
    expect(r3G.day).toBe(D3);
    expect(r3D.day).toBe(D3);
    const kinds3G = await itemsFor(geger as number, D3);
    const kinds3D = await itemsFor(didi as number, D3);
    expect(kinds3G.length, "哥哥次日应有复习+新词").toBeGreaterThanOrEqual(2);
    expect(kinds3G[0], "哥哥昨日错词应最先到期复习").toMatchObject({ senseId: sense, kind: "due" });
    expect(kinds3G.slice(1).every((i) => i.kind === "new"), "其余应为新词").toBe(true);
    expect(kinds3D.length, "弟弟次日应有复习+新词").toBeGreaterThanOrEqual(2);
    expect(kinds3D[0], "弟弟昨日答对的卡次日到期复习").toMatchObject({ senseId: sense, kind: "due" });
    expect(kinds3D.slice(1).every((i) => i.kind === "new")).toBe(true);

    // 昨日记录保留：事件、卡片、清单、条目状态、星星
    expect(await count("answer_events"), "作答事件应原样保留").toBe(2);
    expect(await count("user_cards"), "卡片应原样保留").toBe(2);
    expect(await count("daily_lists"), "每天×两人×三天各一份清单").toBe(6);
    const oldG = await itemsFor(geger as number, D2);
    expect(oldG.map((i) => i.status)).toEqual(
      ["correction", ...Array(oldG.length - 1).fill("pending")],
    );
    const oldD = await itemsFor(didi as number, D2);
    expect(oldD.map((i) => i.status)).toEqual(
      ["done", ...Array(oldD.length - 1).fill("pending")],
    );
    const statsDAfter = await db.prepare(
      "SELECT stars, streak_days, last_play_date FROM user_stats WHERE user_id = ?",
    ).bind(didi as number).first<{ stars: number; streak_days: number; last_play_date: string }>();
    expect(statsDAfter, "次日打开不改动星星/连击").toEqual({ stars: 1, streak_days: 1, last_play_date: D2 });
  });
});
