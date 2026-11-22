import { describe, it, expect } from "vitest";
import {
  makeEventId,
  recordDailyAnswer,
  recordPracticeAnswer,
  scheduleDailyItems,
} from "../public/review-client.js";

// ---------- 上报客户端纯函数测试（makePost 模式） ----------
// post: (path, bodyObj) => Promise，按脚本注入失败/成功；记录调用时序供断言。
// 失败规格 {status?: number}：带 status=409 模拟"清单已过日"（服务端 409），
// 不带 status 模拟网络断线（fetch reject，无 HTTP 状态）。
interface FailSpec { status?: number }

function makePost(failSpecs: (FailSpec | null)[] = []) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let n = 0;
  const post = (path: string, body: Record<string, unknown>): Promise<any> => {
    calls.push({ path, body });
    const spec = failSpecs[n++];
    if (spec) {
      const err = new Error(spec.status === 409 ? "清单已过日，请重新打开今日清单" : "net down") as
        Error & { status?: number };
      err.status = spec.status;
      return Promise.reject(err);
    }
    // 成功：回显 eventId 的权威响应形状（/daily/answer 契约的子集）
    return Promise.resolve({
      eventId: body.eventId,
      applied: true,
      stage: "first",
      item: { id: body.itemId, senseId: "s1", term: "apple", meaning: "苹果", status: "done" },
      correct: true,
      rating: "Good",
      starsAwarded: 1,
    });
  };
  return { post, calls };
}

// ---------- makeEventId：eventId 生成规范 ----------

describe("makeEventId：`${userId}:${uuid}` 规范", () => {
  it("带用户前缀，长度不超 100，同用户连续生成不重复", () => {
    const a = makeEventId(7);
    const b = makeEventId(7);
    expect(a).toMatch(/^7:/);
    expect(b).toMatch(/^7:/);
    expect(a).not.toBe(b); // 全局 PK：同用户也不许撞
    expect(a.length).toBeLessThanOrEqual(100);
    expect(a.slice("7:".length)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

// ---------- recordDailyAnswer：每日作答上报 ----------

describe("recordDailyAnswer： eventId 规范与请求形状", () => {
  it("默认生成带用户前缀的 eventId，POST /daily/answer 恰一次，onResult 收到响应", async () => {
    const f = makePost();
    let got: any = "unset";
    const r = await recordDailyAnswer({
      post: f.post, userId: 7, itemId: 42, action: "spell", answer: "apple",
      onResult: (x: any) => { got = x; },
    });
    expect(f.calls).toEqual([
      { path: "/daily/answer", body: { userId: 7, itemId: 42, eventId: expect.any(String), action: "spell", answer: "apple" } },
    ]);
    expect(f.calls[0].body.eventId).toMatch(/^7:/); // 全局 PK 防跨用户碰撞的服务端守卫配套
    expect(got).toBe(r);
    expect(r!.correct).toBe(true);
  });

  it("不传 eventId 时可显式指定（断线后手动续传场景）；reveal 不携带 answer", async () => {
    const f = makePost();
    await recordDailyAnswer({
      post: f.post, userId: 7, itemId: 42, action: "reveal", answer: "ignored",
      eventId: "7:fixed-id",
    });
    const body = f.calls[0].body;
    expect(body.eventId).toBe("7:fixed-id");
    expect(body.action).toBe("reveal");
    expect("answer" in body ? body.answer : undefined).toBeUndefined();
  });
});

describe("recordDailyAnswer：断线重试沿用同一 eventId", () => {
  it("首发网络失败→同 eventId 重发一次→成功；onResult 一次，onError 不触发", async () => {
    const f = makePost([{ }]); // 第一次网络失败（无 status）
    let results = 0, errors = 0;
    const r = await recordDailyAnswer({
      post: f.post, userId: 7, itemId: 42, action: "spell", answer: "apple",
      onResult: () => { results++; }, onError: () => { errors++; },
    });
    expect(f.calls).toHaveLength(2); // 首发 + 重试一次
    expect(f.calls[0].body.eventId).toBe(f.calls[1].body.eventId); // 同一作答重发不换 ID
    expect(results).toBe(1);
    expect(errors).toBe(0);
    expect(r!.applied).toBe(true);
  });

  it("两次都失败：同一 eventId 重发一次后 onError(err, eventId)，onResult 不触发", async () => {
    const f = makePost([{ }, { }]);
    let results = 0;
    let errArg: any = null, idArg: string | null = null;
    const r = await recordDailyAnswer({
      post: f.post, userId: 7, itemId: 42, action: "spell", answer: "apple",
      onResult: () => { results++; },
      onError: (e: unknown, eventId: string) => { errArg = e; idArg = eventId; },
    });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0].body.eventId).toBe(f.calls[1].body.eventId);
    expect(results).toBe(0);
    expect(r).toBeNull();
    expect(errArg).toBeInstanceOf(Error);
    expect(idArg).toBe(f.calls[0].body.eventId); // 上层可保留该 ID 续传
  });
});

describe("recordDailyAnswer：409 停止重试并上报", () => {
  it("首发 409：只有一次调用（不重试），onConflict 上报，onResult/onError 不触发", async () => {
    const f = makePost([{ status: 409 }]);
    let conflicts = 0, results = 0, errors = 0;
    const r = await recordDailyAnswer({
      post: f.post, userId: 7, itemId: 42, action: "spell", answer: "apple",
      onResult: () => { results++; }, onError: () => { errors++; },
      onConflict: () => { conflicts++; },
    });
    expect(f.calls).toHaveLength(1); // 过日清单本地不再重试该事件
    expect(conflicts).toBe(1);
    expect(results).toBe(0);
    expect(errors).toBe(0);
    expect(r).toBeNull();
  });

  it("重试后遇 409 同样终止并上报 onConflict", async () => {
    const f = makePost([{ }, { status: 409 }]); // 首发网络失败，重试时清单已过日
    let conflicts = 0, errors = 0;
    await recordDailyAnswer({
      post: f.post, userId: 7, itemId: 42, action: "spell", answer: "apple",
      onError: () => { errors++; }, onConflict: () => { conflicts++; },
    });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0].body.eventId).toBe(f.calls[1].body.eventId);
    expect(conflicts).toBe(1);
    expect(errors).toBe(0);
  });

  it("其他非 409 的 HTTP 错误（如 404）不重试，走 onError 上报", async () => {
    const f = makePost([{ status: 404 }]);
    let conflicts = 0, errors = 0;
    await recordDailyAnswer({
      post: f.post, userId: 7, itemId: 42, action: "spell", answer: "apple",
      onConflict: () => { conflicts++; }, onError: () => { errors++; },
    });
    expect(f.calls).toHaveLength(1); // 只有网络类失败才值得重试
    expect(errors).toBe(1);
    expect(conflicts).toBe(0);
  });
});

// ---------- scheduleDailyItems：会话队列调度纯函数 ----------

describe("scheduleDailyItems：恢复会话时的队列排序", () => {
  const it7 = (id: number, status: string) => ({
    id, senseId: `s${id}`, term: `t${id}`, meaning: `m${id}`, status,
  });

  it("跳过 done 条目：已完成的词恢复时不再出现", () => {
    const q = scheduleDailyItems([it7(1, "done"), it7(2, "pending"), it7(3, "done")]);
    expect(q.map((w: any) => w.id)).toEqual([2]);
  });

  it("correction 排在所有其他待练词之后；组内保持服务端（position）顺序", () => {
    const q = scheduleDailyItems([
      it7(1, "correction"), it7(2, "pending"), it7(3, "pending"),
      it7(4, "correction"), it7(5, "pending"),
    ]);
    expect(q.map((w: any) => w.id)).toEqual([2, 3, 5, 1, 4]);
  });

  it("只剩 correction（含仅一个错词）时立即进入订正：队列原样保留", () => {
    expect(scheduleDailyItems([it7(9, "correction")]).map((w: any) => w.id)).toEqual([9]);
    const q = scheduleDailyItems([it7(1, "correction"), it7(2, "correction")]);
    expect(q.map((w: any) => w.id)).toEqual([1, 2]);
  });

  it("空清单返回空数组", () => {
    expect(scheduleDailyItems([])).toEqual([]);
  });
});

// ---------- recordPracticeAnswer：自主加练日志（/review sense 路径） ----------

describe("recordPracticeAnswer：加练不调 /daily/answer、不改 due、不完成每日条目", () => {
  const base = { userId: 7, senseId: "pep3a-u1-apple@1", correct: true, source: "unit" };

  it("POST /review（sense 路径）：答对 answer=null；答错携带原始答案", async () => {
    const f = makePost();
    await recordPracticeAnswer({ ...base, post: f.post });
    expect(f.calls.map((c) => c.path)).toEqual(["/review"]);
    expect(f.calls[0].body).toEqual({
      userId: 7, senseId: "pep3a-u1-apple@1", eventId: expect.any(String),
      correct: true, source: "unit", answer: null,
    });
    const g = makePost();
    await recordPracticeAnswer({ ...base, correct: false, source: "mistake", answer: "aple", post: g.post });
    expect(g.calls[0].body).toEqual({
      userId: 7, senseId: "pep3a-u1-apple@1", eventId: expect.any(String),
      correct: false, source: "mistake", answer: "aple",
    });
    expect(g.calls[0].body.eventId).toMatch(/^7:/); // 与每日同一 eventId 规范（全局 PK）
  });

  it("断线重试沿用同一 eventId；成功 onResult 收到响应", async () => {
    const f = makePost([{ }]);
    let results = 0, errors = 0;
    const r = await recordPracticeAnswer({
      ...base, post: f.post, onResult: () => { results++; }, onError: () => { errors++; },
    });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0].body.eventId).toBe(f.calls[1].body.eventId);
    expect(results).toBe(1);
    expect(errors).toBe(0);
    expect(r).not.toBeNull();
  });

  it("两次失败 → onError(err, eventId)，onResult 不触发", async () => {
    const f = makePost([{ }, { }]);
    let results = 0, errors = 0;
    let idArg: string | null = null;
    await recordPracticeAnswer({
      ...base, post: f.post, onResult: () => { results++; },
      onError: (_e: unknown, eventId: string) => { errors++; idArg = eventId; },
    });
    expect(f.calls).toHaveLength(2);
    expect(results).toBe(0);
    expect(errors).toBe(1);
    expect(idArg).toBe(f.calls[0].body.eventId);
  });
});
