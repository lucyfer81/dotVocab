/// <reference types="@cloudflare/vitest-pool-workers" />
// 任务 6：POST /api/daily/answer —— 首次作答、订正与奖励一次生效。
// 建库方式参考 test/daily-list.test.ts：SCHEMA_SQL 按 ; 拆分后 batch 执行。
// 清单/条目用直插夹具，专注作答路径本身；判定依据 curriculum_senses.accepted_json。
// 时区/跨日场景用 vi.setSystemTime 控制 workerd 假时钟（任务 5 已验证可用）。
// 每个用例独占 user id，避免夹具跨用例相撞。
import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SCHEMA_SQL } from "./schema";
import { dayStr } from "../src/daily-list";
import { advanceCard } from "../src/fsrs";

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

async function seedSense(senseId: string, term: string, meaning: string, accepted: string[]) {
  await db.prepare("INSERT INTO curriculum_senses VALUES (?,?,?,?)")
    .bind(senseId, term, meaning, JSON.stringify(accepted)).run();
}

async function seedList(userId: number, studyDate: string): Promise<number> {
  const id = await db.prepare(
    "INSERT INTO daily_lists (user_id, study_date, daily_limit, generation_token) VALUES (?,?,10,?) RETURNING id"
  ).bind(userId, studyDate, `tok-${userId}-${studyDate}`).first<number>("id");
  return id!;
}

async function seedItem(
  listId: number, senseId: string, position: number, kind: "new" | "due", status = "pending",
): Promise<number> {
  const id = await db.prepare(
    "INSERT INTO daily_items (list_id, sense_id, position, kind, status) VALUES (?,?,?,?,?) RETURNING id"
  ).bind(listId, senseId, position, kind, status).first<number>("id");
  return id!;
}

async function seedCard(userId: number, senseId: string, dueAt: number, cardJson: string) {
  await db.prepare("INSERT INTO user_cards (user_id, sense_id, due_at, card_json) VALUES (?,?,?,?)")
    .bind(userId, senseId, dueAt, cardJson).run();
}

// —— 查询辅助 ——

const getEvent = (eventId: string) =>
  db.prepare(
    "SELECT event_id, correct, rating, action, answer, card_before_json, card_after_json, result_json FROM answer_events WHERE event_id=?"
  ).bind(eventId).first<Record<string, unknown>>();

const eventsForItem = async (itemId: number) =>
  (await db.prepare(
    "SELECT event_id, correct, rating, action, answer, card_before_json, card_after_json FROM answer_events WHERE item_id=? ORDER BY created_at, event_id"
  ).bind(itemId).all<Record<string, unknown>>()).results;

const cardOf = (userId: number, senseId: string) =>
  db.prepare("SELECT due_at, card_json FROM user_cards WHERE user_id=? AND sense_id=?")
    .bind(userId, senseId).first<{ due_at: number; card_json: string }>();

const statsOf = (userId: number) =>
  db.prepare("SELECT stars, streak_days, last_play_date FROM user_stats WHERE user_id=?")
    .bind(userId).first<{ stars: number; streak_days: number; last_play_date: string }>();

const itemOf = (itemId: number) =>
  db.prepare("SELECT status, first_event_id FROM daily_items WHERE id=?")
    .bind(itemId).first<{ status: string; first_event_id: string | null }>();

// —— 请求辅助 ——

const answer = (body: Record<string, unknown>) =>
  SELF.fetch("https://example.com/api/daily/answer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

interface AnswerView {
  eventId: string;
  applied: boolean;
  stage: string;
  item: { id: number; senseId: string; term: string; meaning: string; status: string };
  correct: boolean | null;
  rating: string | null;
  starsAwarded: number;
}

async function answerJson(res: Response): Promise<AnswerView> {
  expect(res.status, "应返回 200").toBe(200);
  return await res.json<AnswerView>();
}

describe("每日作答 POST /api/daily/answer", () => {
  it("参数不完整返回 400；用户不存在、条目不存在或他人条目返回 404 且无写入", async () => {
    const u = 300, other = 301;
    await seedUser(u, "校验主");
    await seedUser(other, "校验他人");
    await seedSense("s-da-v@1", "valid", "校验词", ["valid"]);
    const listId = await seedList(u, dayStr(Date.now()));
    const itemId = await seedItem(listId, "s-da-v@1", 0, "new");
    const base = { userId: u, itemId, eventId: "evt-v-ok", action: "spell", answer: "valid" };

    // 坏 JSON
    const bad = await SELF.fetch("https://example.com/api/daily/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{oops",
    });
    expect(bad.status).toBe(400);

    const cases: Record<string, unknown>[] = [
      {},
      { ...base, userId: 0 },
      { ...base, userId: 1.5 },
      { ...base, userId: "1" },
      { ...base, itemId: 0 },
      { ...base, itemId: 1.5 },
      { ...base, eventId: "" },
      { ...base, eventId: 42 },
      { ...base, eventId: "x".repeat(101) },
      { ...base, action: "peek" },
      { ...base, action: "spell", answer: undefined }, // spell 缺字符串 answer（序列化后无 answer 键）
      { ...base, action: "spell", answer: 123 },
    ];
    for (const body of cases) {
      const res = await answer(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }

    // 404：未知用户 / 未知条目 / 他人条目
    expect((await answer({ ...base, userId: 424242 })).status).toBe(404);
    expect((await answer({ ...base, itemId: 987654 })).status).toBe(404);
    const foreign = await answer({ userId: other, itemId, eventId: "evt-v-foreign", action: "spell", answer: "valid" });
    expect(foreign.status).toBe(404);

    // 无任何写入
    expect(await getEvent("evt-v-foreign")).toBeNull();
    const after = await itemOf(itemId);
    expect(after!.status).toBe("pending");
    expect(after!.first_event_id).toBeNull();
    expect(await cardOf(u, "s-da-v@1")).toBeNull();

    // 本人正常提交仍可用（确认 404 不是一刀切拦截）
    const ok = await answer(base);
    expect((await answerJson(ok)).applied).toBe(true);
  });

  it("首次拼写正确只奖一次：Good 加星建卡；同事件重发返回原结果且不重复加星", async () => {
    const u = 302;
    await seedUser(u, "首次对");
    await seedSense("s-da-ok@1", "apple", "苹果", ["apple", "an apple"]);
    const listId = await seedList(u, dayStr(Date.now()));
    const itemId = await seedItem(listId, "s-da-ok@1", 0, "new");

    const nowBefore = Date.now();
    const data = await answerJson(await answer({ userId: u, itemId, eventId: "evt-ok-1", action: "spell", answer: " apple " }));
    expect(data.applied).toBe(true);
    expect(data.stage).toBe("first");
    expect(data.correct).toBe(true);
    expect(data.rating).toBe("Good");
    expect(data.starsAwarded).toBe(1);
    expect(data.item).toEqual({
      id: itemId, senseId: "s-da-ok@1", term: "apple", meaning: "苹果", status: "done",
    });

    // 卡片：FSRS 状态带审计字段，到期在未来
    const card = await cardOf(u, "s-da-ok@1");
    expect(card!.card_json.startsWith("fsrs-v1:")).toBe(true);
    expect(card!.card_json).toContain('"last_review"');
    expect(card!.due_at).toBeGreaterThan(nowBefore);

    // 事件：评级 Good，前状态为空（新词），result_json 存权威返回
    const ev = await getEvent("evt-ok-1");
    expect(ev!.rating).toBe("Good");
    expect(ev!.correct).toBe(1);
    expect(ev!.card_before_json).toBeNull();
    expect(ev!.card_after_json).toBe(card!.card_json);
    expect(JSON.parse(ev!.result_json as string)).toEqual(data);

    // 星星与连续天数
    const stats = await statsOf(u);
    expect(stats!.stars).toBe(1);
    expect(stats!.streak_days).toBe(1);
    expect(stats!.last_play_date).toBe(dayStr(Date.now()));

    // 同事件重发：返回原结果，无新增副作用
    const res2 = await answer({ userId: u, itemId, eventId: "evt-ok-1", action: "spell", answer: "apple" });
    expect(res2.status).toBe(200);
    expect(await res2.json<AnswerView>()).toEqual(data);
    expect((await statsOf(u))!.stars).toBe(1);
    expect((await eventsForItem(itemId)).length).toBe(1);

    // 已完成条目再提交（新事件）：只回权威状态，不产生评级/加星/卡片写入
    const late = await answer({ userId: u, itemId, eventId: "evt-ok-late", action: "spell", answer: "apple" });
    expect(late.status).toBe(200);
    const lateData = await late.json<AnswerView>();
    expect(lateData.applied).toBe(false);
    expect(lateData.stage).toBe("already_done");
    expect(lateData.correct).toBe(true); // 回显首次作答的判定
    expect(lateData.rating).toBe("Good");
    expect(lateData.starsAwarded).toBe(0);
    expect(lateData.item.status).toBe("done");
    expect((await eventsForItem(itemId)).length).toBe(1);
    expect((await statsOf(u))!.stars).toBe(1);
    expect(await cardOf(u, "s-da-ok@1")).toEqual(card);
  });

  it("答错→订正正确：只留一个 Again、只记一次首次错误，订正不加星不碰卡", async () => {
    const u = 303;
    await seedUser(u, "订正对");
    await seedSense("s-da-fix@1", "is", "是", ["is", "'s"]);
    const listId = await seedList(u, dayStr(Date.now()));
    const itemId = await seedItem(listId, "s-da-fix@1", 0, "new");

    // 首次答错
    const d1 = await answerJson(await answer({ userId: u, itemId, eventId: "evt-fix-1", action: "spell", answer: "are" }));
    expect(d1.applied).toBe(true);
    expect(d1.correct).toBe(false);
    expect(d1.rating).toBe("Again");
    expect(d1.starsAwarded).toBe(0);
    expect(d1.item.status).toBe("correction");
    const cardAfterFirst = await cardOf(u, "s-da-fix@1");
    expect(cardAfterFirst!.card_json.startsWith("fsrs-v1:")).toBe(true);

    // 订正正确：仅推进条目
    const d2 = await answerJson(await answer({ userId: u, itemId, eventId: "evt-fix-2", action: "spell", answer: "is" }));
    expect(d2.applied).toBe(true);
    expect(d2.stage).toBe("correction");
    expect(d2.correct).toBe(true);
    expect(d2.rating).toBeNull();
    expect(d2.starsAwarded).toBe(0);
    expect(d2.item.status).toBe("done");

    // 卡片不被订正改写
    expect(await cardOf(u, "s-da-fix@1")).toEqual(cardAfterFirst);
    // 不为订正加星：全程无星星写入
    expect(await statsOf(u)).toBeNull();

    // 事件审计：只有一条 Again（首次），订正事件无评级、无卡片前后状态
    const evs = await eventsForItem(itemId);
    expect(evs).toHaveLength(2);
    const first = evs.find((e) => e.event_id === "evt-fix-1")!;
    const corr = evs.find((e) => e.event_id === "evt-fix-2")!;
    expect(first.correct).toBe(0);
    expect(first.rating).toBe("Again");
    expect(corr.correct).toBe(1);
    expect(corr.rating).toBeNull();
    expect(corr.card_before_json).toBeNull();
    expect(corr.card_after_json).toBeNull();
    // first_event_id 保留首次事件
    expect((await itemOf(itemId))!.first_event_id).toBe("evt-fix-1");
    // 每日作答不写旧 wrong_answer_events（新世界的首次错拼记录在 answer_events）
    expect(await db.prepare("SELECT COUNT(*) AS n FROM wrong_answer_events").first<number>("n")).toBe(0);

    // 同事件重发订正事件：返回原结果
    const r3 = await answer({ userId: u, itemId, eventId: "evt-fix-2", action: "spell", answer: "is" });
    expect(await r3.json<AnswerView>()).toEqual(d2);
    expect((await eventsForItem(itemId)).length).toBe(2);
  });

  it("订正再答错保持 correction：不产生新评级，不重复记错，之后仍可订正完成", async () => {
    const u = 304;
    await seedUser(u, "订正错");
    await seedSense("s-da-cw@1", "their", "他们的", ["their"]);
    const listId = await seedList(u, dayStr(Date.now()));
    const itemId = await seedItem(listId, "s-da-cw@1", 0, "new");

    // 首次答错 → correction
    const d1 = await answerJson(await answer({ userId: u, itemId, eventId: "evt-cw-1", action: "spell", answer: "thier" }));
    expect(d1.item.status).toBe("correction");
    const cardAfterFirst = await cardOf(u, "s-da-cw@1");

    // 订正又答错：保持 correction，事件记录但无评级
    const d2 = await answerJson(await answer({ userId: u, itemId, eventId: "evt-cw-2", action: "spell", answer: "tere" }));
    expect(d2.applied).toBe(true);
    expect(d2.stage).toBe("correction");
    expect(d2.correct).toBe(false);
    expect(d2.rating).toBeNull();
    expect(d2.item.status).toBe("correction");

    // 订正阶段看答案：同样视为订正未完成
    const d3 = await answerJson(await answer({ userId: u, itemId, eventId: "evt-cw-3", action: "reveal" }));
    expect(d3.correct).toBe(false);
    expect(d3.rating).toBeNull();
    expect(d3.item.status).toBe("correction");

    // 卡片始终是首次那一份；first_event_id 不变；无星星
    expect(await cardOf(u, "s-da-cw@1")).toEqual(cardAfterFirst);
    expect((await itemOf(itemId))!.first_event_id).toBe("evt-cw-1");
    expect(await statsOf(u)).toBeNull();

    // 事件：1 条首次 Again + 2 条订正失败（correct=0 且无评级），无重复评级
    const evs = await eventsForItem(itemId);
    expect(evs).toHaveLength(3);
    expect(evs.filter((e) => e.rating !== null)).toHaveLength(1);
    expect(evs.filter((e) => e.rating === "Again")).toHaveLength(1);

    // 之后订正正确仍能完成
    const d4 = await answerJson(await answer({ userId: u, itemId, eventId: "evt-cw-4", action: "spell", answer: "their" }));
    expect(d4.item.status).toBe("done");
    expect((await eventsForItem(itemId)).length).toBe(4);
    expect((await itemOf(itemId))!.first_event_id).toBe("evt-cw-1");
  });

  it("action='reveal' 首次看答案直接 Again：不判定答案内容，answer 记 NULL", async () => {
    const u = 305;
    await seedUser(u, "看答案");
    await seedSense("s-da-reveal@1", "cover", "掩盖", ["cover"]);
    const listId = await seedList(u, dayStr(Date.now()));
    const itemId = await seedItem(listId, "s-da-reveal@1", 0, "new");

    const d = await answerJson(await answer({ userId: u, itemId, eventId: "evt-rv-1", action: "reveal", answer: "whatever" }));
    expect(d.applied).toBe(true);
    expect(d.stage).toBe("first");
    expect(d.correct).toBe(false);
    expect(d.rating).toBe("Again");
    expect(d.starsAwarded).toBe(0);
    expect(d.item.status).toBe("correction");

    const ev = await getEvent("evt-rv-1");
    expect(ev!.action).toBe("reveal");
    expect(ev!.answer).toBeNull();
    expect(ev!.rating).toBe("Again");
    expect(ev!.correct).toBe(0);
    // 卡片仍按 Again 更新
    const card = await cardOf(u, "s-da-reveal@1");
    expect(card!.card_json.startsWith("fsrs-v1:")).toBe(true);
    expect(card!.card_json).toBe(ev!.card_after_json);
    expect(await statsOf(u)).toBeNull();
  });

  it("两台设备并发相反答案：只产生一次评级，星星只按首次作答发", async () => {
    const u = 306;
    await seedUser(u, "并发");
    await seedSense("s-da-race@1", "sun", "太阳", ["sun"]);
    const listId = await seedList(u, dayStr(Date.now()));
    const itemId = await seedItem(listId, "s-da-race@1", 0, "new");

    const [ra, rb] = await Promise.all([
      answer({ userId: u, itemId, eventId: "evt-race-a", action: "spell", answer: "sun" }),
      answer({ userId: u, itemId, eventId: "evt-race-b", action: "spell", answer: "moon" }),
    ]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    const da = await ra.json<AnswerView>();
    const dbRow = await rb.json<AnswerView>();

    // Review Focus #4：只认先成功持久化的首次作答 —— 评级恰好一条。
    // 交叠语义说明：契约没有提交阶段字段，"并发首次作答"与"紧随其后的订正"
    // payload 完全不可区分；若一方的请求在另一方落库后才被处理，它会成为一次
    // 合法的订正完成（applied 可为真，但 rating 为 null、不加星、不碰卡）。
    // 因此本用例锁定的是任何交叠下都必须稳定成立的不变量：
    const evs = await eventsForItem(itemId);
    const rated = evs.filter((e) => e.rating !== null);
    expect(rated).toHaveLength(1); // 只产生一次评级
    expect(rated[0].rating === "Good" || rated[0].rating === "Again").toBe(true);
    const winnerCorrect = rated[0].correct === 1;
    // 评级事件必出自两台设备之一的 eventId（首次作答必被持久化）
    expect([da.eventId, dbRow.eventId]).toContain(rated[0].event_id);

    // 卡片只写一次，且与评级事件的 card_after 审计一致
    const card = await cardOf(u, "s-da-race@1");
    expect(card!.card_json).toBe(rated[0].card_after_json);
    expect(rated[0].card_before_json).toBeNull(); // 新词首答

    // 星星只按首次作答发：答对恰 1 星；答错 0 星（订正完成不加星）
    const stats = await statsOf(u);
    expect(stats?.stars ?? 0).toBe(winnerCorrect ? 1 : 0);

    // 两台设备都拿到权威条目状态：已离开 pending（done 或待订正）；
    // 库内最终状态同样已离开 pending
    for (const view of [da, dbRow]) {
      expect(view.item.status === "done" || view.item.status === "correction").toBe(true);
    }
    const finalStatus = (await itemOf(itemId))!.status;
    expect(finalStatus === "done" || finalStatus === "correction").toBe(true);
  });

  it("跨用户 eventId 碰撞：后到者 applied=false 零写入，不 500 不悬挂", async () => {
    const a = 311, b = 312;
    await seedUser(a, "碰撞甲");
    await seedUser(b, "碰撞乙");
    await seedSense("s-da-cl-a@1", "collidea", "甲词", ["collidea"]);
    await seedSense("s-da-cl-b@1", "collideb", "乙词", ["collideb"]);
    const listA = await seedList(a, dayStr(Date.now()));
    const itemA = await seedItem(listA, "s-da-cl-a@1", 0, "new");
    const listB = await seedList(b, dayStr(Date.now()));
    const itemB = await seedItem(listB, "s-da-cl-b@1", 0, "new");

    // A 用 evX 正常完成自己的条目
    const dA = await answerJson(await answer({ userId: a, itemId: itemA, eventId: "evt-collide", action: "spell", answer: "collidea" }));
    expect(dA.applied).toBe(true);

    // B 撞用 evX 提交自己的 pending 条目：跨用户事件守卫拦截 → 落选零写入，无 500
    const dB = await answerJson(await answer({ userId: b, itemId: itemB, eventId: "evt-collide", action: "spell", answer: "collideb" }));
    expect(dB.applied).toBe(false);
    expect(dB.stage).toBe("first");
    expect(dB.item.status).toBe("pending");
    expect(dB.starsAwarded).toBe(0);

    // B 的条目零写入、无悬挂态
    const bItem = await itemOf(itemB);
    expect(bItem!.status).toBe("pending");
    expect(bItem!.first_event_id).toBeNull();
    expect(await eventsForItem(itemB)).toHaveLength(0);
    expect(await cardOf(b, "s-da-cl-b@1")).toBeNull();
    expect(await statsOf(b)).toBeNull();

    // evX 唯一且归属 A；A 的进度不被触碰
    expect(await db.prepare("SELECT COUNT(*) AS n FROM answer_events WHERE event_id='evt-collide'").first<number>("n")).toBe(1);
    expect((await itemOf(itemA))!.first_event_id).toBe("evt-collide");
    expect((await itemOf(itemA))!.status).toBe("done");
    expect((await statsOf(a))!.stars).toBe(1);

    // 订正路径同样防护：B 先答错进入 correction，再撞用 evX 订正 → 落选保持 correction
    const dWrong = await answerJson(await answer({ userId: b, itemId: itemB, eventId: "evt-collide-b1", action: "spell", answer: "nope" }));
    expect(dWrong.applied).toBe(true);
    expect(dWrong.item.status).toBe("correction");
    const cardB = await cardOf(b, "s-da-cl-b@1");
    const dB2 = await answerJson(await answer({ userId: b, itemId: itemB, eventId: "evt-collide", action: "spell", answer: "collideb" }));
    expect(dB2.applied).toBe(false);
    expect(dB2.stage).toBe("correction");
    expect(dB2.item.status).toBe("correction");
    expect(dB2.starsAwarded).toBe(0);
    // B 的首次事件仍是唯一记录；卡与条目状态不被订正碰撞触碰
    const evsB = await eventsForItem(itemB);
    expect(evsB).toHaveLength(1);
    expect(evsB[0].event_id).toBe("evt-collide-b1");
    expect((await itemOf(itemB))!.first_event_id).toBe("evt-collide-b1");
    expect((await itemOf(itemB))!.status).toBe("correction");
    expect(await cardOf(b, "s-da-cl-b@1")).toEqual(cardB);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM answer_events WHERE event_id='evt-collide'").first<number>("n")).toBe(1);
  });

  it("过上海午夜迟交返回 409 且无任何副作用；当天也不能补交昨日清单", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-25T22:00:00+08:00"));
    const u = 307;
    await seedUser(u, "迟交");
    await seedSense("s-da-late1@1", "late1", "迟交词1", ["late1"]);
    await seedSense("s-da-late2@1", "late2", "迟交词2", ["late2"]);
    const todayList = await seedList(u, "2026-11-25");
    const todayItem = await seedItem(todayList, "s-da-late1@1", 0, "new");
    const oldList = await seedList(u, "2026-11-24");
    const oldItem = await seedItem(oldList, "s-da-late2@1", 0, "new");

    // 当天 22:00 补交昨日清单：study_date 不匹配 → 409
    const rOld = await answer({ userId: u, itemId: oldItem, eventId: "evt-late-old", action: "spell", answer: "late2" });
    expect(rOld.status).toBe(409);

    // 次日上午补交昨晚打开的清单：409
    vi.setSystemTime(new Date("2026-11-26T09:00:00+08:00"));
    const rLate = await answer({ userId: u, itemId: todayItem, eventId: "evt-late-1", action: "spell", answer: "late1" });
    expect(rLate.status).toBe(409);
    expect(((await rLate.json<Record<string, string>>()) as Record<string, string>).error).toBeTruthy();

    // 无任何副作用：条目原样、无事件、无卡片、无星星
    for (const id of [todayItem, oldItem]) {
      const row = await itemOf(id);
      expect(row!.status).toBe("pending");
      expect(row!.first_event_id).toBeNull();
    }
    expect(await getEvent("evt-late-1")).toBeNull();
    expect(await getEvent("evt-late-old")).toBeNull();
    expect(await cardOf(u, "s-da-late1@1")).toBeNull();
    expect(await cardOf(u, "s-da-late2@1")).toBeNull();
    expect(await statsOf(u)).toBeNull();
  });

  it("accepted_json 多候选按 trim+小写判定：别名可用，大小写空格容错", async () => {
    const u = 308;
    await seedUser(u, "别名");
    await seedSense("s-da-alias@1", "hello", "你好", ["hello", "hi"]);
    await seedSense("s-da-alias2@1", "world", "世界", ["world"]);
    const listId = await seedList(u, dayStr(Date.now()));
    const itemId1 = await seedItem(listId, "s-da-alias@1", 0, "new");
    const itemId2 = await seedItem(listId, "s-da-alias2@1", 1, "new");

    // 别名 hi 命中，trim + 大小写容错
    const d1 = await answerJson(await answer({ userId: u, itemId: itemId1, eventId: "evt-al-1", action: "spell", answer: "  HI  " }));
    expect(d1.correct).toBe(true);
    expect(d1.item.status).toBe("done");
    // 不在候选内 → 错
    const d2 = await answerJson(await answer({ userId: u, itemId: itemId2, eventId: "evt-al-2", action: "spell", answer: "hallo" }));
    expect(d2.correct).toBe(false);
    expect(d2.item.status).toBe("correction");
  });

  it("到期卡作答：card_before/after 审计齐全，due 推进，星星照发", async () => {
    const u = 310;
    await seedUser(u, "复习");
    await seedSense("s-da-due@1", "dueword", "到期词", ["dueword"]);
    const seeded = advanceCard(null, "Good", Date.now());
    await seedCard(u, "s-da-due@1", seeded.dueMs, seeded.state);
    const listId = await seedList(u, dayStr(Date.now()));
    const itemId = await seedItem(listId, "s-da-due@1", 0, "due");

    const d = await answerJson(await answer({ userId: u, itemId, eventId: "evt-due-1", action: "spell", answer: "dueword" }));
    expect(d.rating).toBe("Good");
    expect(d.starsAwarded).toBe(1);

    const ev = await getEvent("evt-due-1");
    expect(ev!.card_before_json).toBe(seeded.state);
    const card = await cardOf(u, "s-da-due@1");
    expect(card!.card_json).not.toBe(seeded.state);
    expect(card!.card_json).toBe(ev!.card_after_json);
    expect(card!.due_at).toBeGreaterThan(seeded.dueMs); // 连对间隔变长
    expect((await statsOf(u))!.stars).toBe(1);
  });
});
