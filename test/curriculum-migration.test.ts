import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { LEGACY_SCHEMA_SQL, CUTOVER_SQL } from "./schema";
// @ts-expect-error offline Node generator has no TS declarations
import { curriculumStatements } from "../scripts/build-curriculum-sql.mjs";

const db = env.DB as D1Database;
async function run(sql: string) {
  const statements = sql.split(";").map(s => s.trim()).filter(Boolean);
  if (statements.length) await db.batch(statements.map(s => db.prepare(s)));
}

it("切换保留两个账号，清空旧进度、奖励和共享池", async () => {
  await run(LEGACY_SCHEMA_SQL);
  const users = () => db.prepare("SELECT * FROM users ORDER BY id").all();
  const before = (await users()).results;
  expect(before).toHaveLength(2);
  await run(`
    INSERT INTO user_word_state(user_id,word_id,reps) SELECT id,1,3 FROM users;
    INSERT INTO user_unit_word_seen SELECT id,1,1,42 FROM users;
    INSERT INTO wrong_answer_events(user_id,word_id,created_at) SELECT id,1,42 FROM users;
    INSERT INTO user_stats SELECT id,7,2,'2026-11-21' FROM users;
  `);
  await run(CUTOVER_SQL);
  expect((await users()).results).toEqual(before);
  for (const table of ["pool_units", "user_word_state", "user_unit_word_seen", "wrong_answer_events", "user_stats"]) {
    expect(await db.prepare(`SELECT count(*) n FROM ${table}`).first("n")).toBe(0);
  }
});

it("按稳定词义和教材位置更新，不覆盖换库后的记录", async () => {
  await run(LEGACY_SCHEMA_SQL);
  await run(CUTOVER_SQL);
  const entry = { unit: 1, row: 3, senseKey: "cat@1", term: "cat", meaning: "猫", accepted: ["cat"] };
  const data = { books: [{ id: "一上", title: "一年级上", entries: [
    entry, { ...entry, unit: 2 }, { ...entry, row: 4, senseKey: "cat@2", meaning: "猫科动物" },
  ] }] };
  const load = () => db.batch((curriculumStatements(data) as string[]).map(s => db.prepare(s)));
  await load();
  await run(`
    INSERT INTO pool_units VALUES(1);
    INSERT INTO user_quotas VALUES(1,15);
    INSERT INTO user_cards VALUES(1,'cat@1',123,'{}');
    INSERT INTO daily_lists VALUES(7,1,'2026-11-22',15,'token');
    INSERT INTO daily_items VALUES(8,7,'cat@1',0,'due','done','e1');
    INSERT INTO answer_events(event_id,user_id,sense_id,item_id,source,action,correct,created_at) VALUES('e1',1,'cat@1',8,'daily','spell',1,42);
    INSERT INTO user_stats VALUES(1,5,1,'2026-11-22');
  `);
  const tables = ["pool_units","user_quotas","user_cards","daily_lists","daily_items","answer_events","user_stats"];
  const snapshot = () => Promise.all(tables.map(async t => (await db.prepare(`SELECT * FROM ${t}`).all()).results));
  const before = await snapshot();
  entry.term = "cat's";
  await load();
  expect(await snapshot()).toEqual(before);
  expect(await db.prepare("SELECT term FROM curriculum_senses WHERE sense_id='cat@1'").first("term")).toBe("cat's");
  expect(await db.prepare("SELECT count(*) n FROM curriculum_senses").first("n")).toBe(2);
  expect(await db.prepare("SELECT count(*) n FROM curriculum_unit_senses").first("n")).toBe(3);
});
