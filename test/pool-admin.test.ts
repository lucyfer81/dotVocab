/// <reference types="@cloudflare/vitest-pool-workers" />
import { env, SELF } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
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

it.each([["curriculum","GET"], ["pool","POST"], ["quota","PUT"]])("%s 需要管理凭据", async (path, method) => {
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
