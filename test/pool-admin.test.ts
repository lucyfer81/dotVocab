/// <reference types="@cloudflare/vitest-pool-workers" />
import { env, SELF } from "cloudflare:test";
import { beforeAll, expect, it, vi } from "vitest";
import { advanceCard } from "../src/fsrs";
import { adminToken } from "./helpers";
import { SCHEMA_SQL } from "./schema";

declare module "cloudflare:test" {
  interface ProvidedEnv { DB: D1Database }
}
const db = env.DB;
beforeAll(async () => {
  const sql = SCHEMA_SQL + `INSERT INTO curriculum_units VALUES
    (5,'b','第二册',1,1),(3,'a','第一册',0,2),(2,'a','第一册',0,0);`;
  await db.batch(sql.split(";").map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)));
});
function request(path: string, method = "GET", body?: unknown, auth = true) {
  return SELF.fetch(`https://example.com/api/admin/${path}`, {
    method, headers: auth ? { "x-admin-token": adminToken } : {},
    body: JSON.stringify(body),
  });
}
const catalog = async () => (await request("curriculum")).json<{
  books: {book: string; title: string; units: {id: number; unit: number; open: boolean}[]}[];
  quotas: {userId: number; name: string; limit: number}[];
}>();

it.each([["curriculum","GET"], ["pool","POST"], ["quota","PUT"], ["progress","GET"], ["vocabulary/1","GET"]])("%s 需要管理凭据", async (path, method) => {
  expect((await request(path, method, undefined, false)).status).toBe(401);
});
it("混有不存在的单元时整批拒绝", async () => {
  expect((await request("pool","POST",{unitIds:[2,999]})).status).toBe(400);
  expect(await db.prepare("SELECT COUNT(*) FROM pool_units").first("COUNT(*)")).toBe(0);
});
it("一次开放多个单元，重复加入保持相同目录状态", async () => {
  for (let i = 0; i < 2; i++) {
    expect((await request("pool","POST",{unitIds:[3,2,3]})).status).toBe(200);
    expect((await catalog()).books).toEqual([
      {book:"a",title:"第一册",units:[{id:2,unit:0,open:true},{id:3,unit:2,open:true}]},
      {book:"b",title:"第二册",units:[{id:5,unit:1,open:false}]},
    ]);
  }
});
it("拒绝配额 12，更改哥哥时弟弟仍为默认 10", async () => {
  expect((await request("quota","PUT",{userId:1,limit:12})).status).toBe(400);
  expect((await catalog()).quotas.map(q => q.limit)).toEqual([10,10]);
  expect((await request("quota","PUT",{userId:1,limit:15})).status).toBe(200);
  expect((await catalog()).quotas).toEqual([
    {userId:1,name:"哥哥",limit:15},{userId:2,name:"弟弟",limit:10},
  ]);
});

it("进度按上海日读取固定清单，订正与共享池覆盖各自统计", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-28T16:15:00Z"));
  try {
    await db.batch([
      db.prepare(`INSERT INTO curriculum_senses VALUES
        ('apple','apple','苹果','["apple"]'),('banana','banana','香蕉','["banana"]'),
        ('pear','pear','梨','["pear"]'),('orange','orange','橙子','["orange"]')`),
      db.prepare(`INSERT INTO curriculum_unit_senses VALUES
        (2,'apple',1),(2,'banana',2),(3,'apple',1),(3,'pear',2),(5,'apple',1),(5,'orange',2)`),
      db.prepare("INSERT INTO pool_units VALUES (2),(3)"),
      db.prepare("INSERT INTO user_cards VALUES (1,'orange',?,'{}')").bind(Date.now() + 86_400_000),
      db.prepare("INSERT INTO daily_lists VALUES (100,2,'2026-11-28',10,'yesterday')"),
    ]);
    const progress = async () => {
      const res = await request("progress");
      expect(res.status).toBe(200);
      return res.json<{ id: number; daily: unknown; pool: { practiced: number; total: number } }[]>();
    };
    const kidPost = (path: string, body: object) => SELF.fetch(`https://example.com/api/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const [before, siblingBefore] = await progress();
    expect(before).toMatchObject({ id: 1, daily: null, pool: { practiced: 0, total: 3 } });
    expect(siblingBefore).toMatchObject({ id: 2, daily: null });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM daily_lists").first("n")).toBe(1);

    const opened = await kidPost("daily/open", { userId: 1 });
    expect(opened.status).toBe(200);
    const { items } = await opened.json<{ items: { id: number; term: string }[] }>();
    const [apple, banana] = items;
    const answer = (itemId: number, eventId: string, value: string) =>
      kidPost("daily/answer", { userId: 1, itemId, eventId, action: "spell", answer: value });
    expect((await answer(apple.id, "progress-wrong", "wrong")).status).toBe(200);
    expect((await answer(banana.id, "progress-correct", "banana")).status).toBe(200);
    const expectedDaily = { day: "2026-11-29", limit: 10, total: 3, done: 1, correction: 1, pending: 1 };
    expect((await progress())[0]).toMatchObject({ daily: expectedDaily, pool: { practiced: 2, total: 3 } });

    await db.prepare("INSERT INTO daily_lists VALUES (102,2,'2026-11-29',10,'empty-today')").run();
    expect((await request("pool", "POST", { unitIds: [5] })).status).toBe(200);
    expect((await request("quota", "PUT", { userId: 1, limit: 15 })).status).toBe(200);
    const [afterPool, sibling] = await progress();
    expect(afterPool).toMatchObject({ daily: expectedDaily, pool: { practiced: 3, total: 4 } });
    expect(sibling).toMatchObject({
      daily: { day: "2026-11-29", limit: 10, total: 0, done: 0, correction: 0, pending: 0 },
      pool: { practiced: 0, total: 4 },
    });

    expect((await answer(apple.id, "progress-correction", "apple")).status).toBe(200);
    expect((await progress())[0]).toMatchObject({
      daily: { ...expectedDaily, done: 2, correction: 0 }, pool: { practiced: 3, total: 4 },
    });
  } finally {
    vi.useRealTimers();
  }
});

it("旧版按范围深度重置请求保留每日任务、复习卡片和作答记录", async () => {
  await db.batch([
    db.prepare("INSERT INTO curriculum_senses VALUES ('reset-apple','apple','苹果','[]')"),
    db.prepare("INSERT INTO user_cards VALUES (1,'reset-apple',100,'{}')"),
    db.prepare("INSERT INTO daily_lists VALUES (100,1,'2026-11-29',10,'reset-list')"),
    db.prepare("INSERT INTO daily_items (id,list_id,sense_id,position,kind) VALUES (1,100,'reset-apple',0,'new')"),
    db.prepare(`INSERT INTO answer_events (event_id,user_id,sense_id,item_id,source,action,correct,created_at)
      VALUES ('reset-event',1,'reset-apple',1,'daily','spell',0,100)`),
  ]);
  for (const scope of [{ scope: "unit", unit_id: 2 }, { scope: "book", book: "a" }]) {
    const res = await request("reset-progress", "POST", { ...scope, user_ids: [1], deep: true });
    expect(res.status).toBe(200);
    for (const table of ["user_cards", "daily_lists", "daily_items", "answer_events"]) {
      expect(await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n")).toBe(1);
    }
  }
});

it("词汇详情区分无效孩子与空共享池", async () => {
  expect((await request("vocabulary/0")).status).toBe(400);
  expect((await request("vocabulary/999")).status).toBe(404);
  const res = await request("vocabulary/1");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ user: { id: 1 }, entries: [] });
});

it("词汇详情按孩子和词义读取 FSRS 状态，保留教材位置并排除池外词义", async () => {
  vi.useFakeTimers();
  const now = Date.parse("2026-11-28T16:15:00Z");
  vi.setSystemTime(now);
  try {
    const day = 86_400_000;
    const firstGood = advanceCard(null, "Good", now - 5 * day);
    const learning = advanceCard(null, "Again", now);
    const review = advanceCard(firstGood.state, "Good", now - 4 * day);
    const relearning = advanceCard(review.state, "Again", now);
    const todayEnd = Date.parse("2026-11-29T23:59:59.999+08:00");
    const tomorrow = todayEnd + 1;
    await db.batch([
      db.prepare(`INSERT INTO curriculum_senses VALUES
        ('light-a','light','光','[]'),('light-b','light','轻的','[]'),
        ('pear','pear','梨','[]'),('plum','plum','李子','[]'),
        ('old','old','旧的','[]'),('closed','closed','关闭','[]')`),
      db.prepare(`INSERT INTO curriculum_unit_senses VALUES
        (2,'light-a',1),(2,'light-b',2),(2,'pear',3),
        (3,'light-a',1),(3,'plum',2),(3,'old',3),(5,'light-a',1),(5,'closed',2)`),
      db.prepare("INSERT INTO pool_units VALUES (2),(3)"),
      db.prepare(`INSERT INTO user_cards VALUES
        (1,'light-a',?,?),(1,'pear',?,?),(1,'plum',?,?),
        (1,'old',?,'{}'),(1,'closed',?,?),(2,'light-a',?,?)`).bind(
        todayEnd, learning.state, tomorrow, review.state, relearning.dueMs, relearning.state,
        todayEnd, todayEnd, learning.state, tomorrow, review.state,
      ),
      db.prepare(`INSERT INTO answer_events (event_id,user_id,sense_id,source,action,correct,created_at,rating) VALUES
        ('first-wrong',1,'light-a','daily','spell',0,1,'Again'),
        ('correction',1,'light-a','daily','spell',1,2,NULL),
        ('practice',1,'light-a','unit','spell',1,3,NULL),
        ('other-child',2,'light-a','daily','spell',1,4,'Good')`),
    ]);

    const fetchVocabulary = async (userId: number) => {
      const res = await request(`vocabulary/${userId}`);
      expect(res.status).toBe(200);
      return res.json<{ today: string; entries: { senseId: string; stage: string }[] }>();
    };
    const { entries, today } = await fetchVocabulary(1);
    expect(today).toBe("2026-11-29");
    expect(entries.map(({ senseId, stage }) => [senseId, stage])).toEqual([
      ["light-a", "learning"], ["light-b", "not_started"], ["pear", "review"],
      ["plum", "relearning"], ["old", "unknown"],
    ]);
    expect(entries[0]).toMatchObject({
      term: "light", meaning: "光", dueOn: today, lastRating: "Again",
      locations: [
        { unitId: 2, bookTitle: "第一册", unit: 0, open: true },
        { unitId: 3, bookTitle: "第一册", unit: 2, open: true },
        { unitId: 5, bookTitle: "第二册", unit: 1, open: false },
      ],
    });
    expect(entries[1]).toMatchObject({ term: "light", meaning: "轻的", dueOn: null, lastRating: null });
    expect(entries[2]).toMatchObject({ dueOn: "2026-11-30" });
    expect((await fetchVocabulary(2)).entries[0]).toMatchObject({ stage: "review", lastRating: "Good" });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM daily_lists").first("n")).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
