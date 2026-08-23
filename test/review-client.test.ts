import { describe, it, expect } from "vitest";
import { recordAnswer } from "../public/review-client.js";

// ---------- 乐观上报：并行、非阻塞、失败回调 ----------
// post: (path, bodyObj) => Promise；记录调用时序供并行/非阻塞断言
function makePost(opts: { failReview?: boolean; failCover?: boolean } = {}) {
  const calls: { path: string; body: Record<string, unknown>; at: number }[] = [];
  const gates: { resolve: () => void }[] = [];
  let n = 0;
  const post = (path: string, body: Record<string, unknown>) => {
    const seq = ++n;
    calls.push({ path, body, at: seq });
    return new Promise<void>((resolve, reject) => {
      gates.push({
        resolve: () => (path === "/review" && opts.failReview) || (path === "/cover" && opts.failCover)
          ? reject(new Error("net"))
          : resolve(),
      });
    });
  };
  return {
    post,
    calls,
    // 放行第 k 个（1-based）尚未完成的请求
    release(k: number) { gates[k - 1].resolve(); },
    releaseAll() { gates.forEach((g) => g.resolve()); },
  };
}

const base = { userId: 7, wordId: 42, correct: true, unitId: 3 };

describe("recordAnswer", () => {
  it("posts /review always, and /cover only when unit && correct", () => {
    const f = makePost();
    recordAnswer({ ...base, post: f.post, onError: () => {} });
    f.releaseAll();
    const wrongUnit = makePost();
    recordAnswer({ ...base, correct: false, post: wrongUnit.post, onError: () => {} });
    wrongUnit.releaseAll();
    const noUnit = makePost();
    recordAnswer({ ...base, unitId: null, post: noUnit.post, onError: () => {} });
    noUnit.releaseAll();
    expect(f.calls.map((c) => c.path)).toEqual(["/review", "/cover"]);
    expect(wrongUnit.calls.map((c) => c.path)).toEqual(["/review"]); // 答错不计覆盖
    expect(noUnit.calls.map((c) => c.path)).toEqual(["/review"]);
  });

  it("sends both requests in parallel (cover fires before review resolves)", () => {
    const f = makePost();
    recordAnswer({ ...base, post: f.post, onError: () => {} });
    // review 仍未完成，但 cover 已发出 —— 并行而非串行
    expect(f.calls.map((c) => c.path)).toEqual(["/review", "/cover"]);
    f.releaseAll();
  });

  it("returns immediately without waiting for the network (non-blocking)", () => {
    const f = makePost();
    let returned = false;
    recordAnswer({ ...base, post: f.post, onError: () => {} });
    returned = true;
    expect(returned).toBe(true); // 同步返回时两个请求都还挂着
    expect(f.calls.length).toBe(2);
    f.releaseAll();
  });

  it("calls onError once when any request fails, never throws", async () => {
    const f = makePost({ failReview: true });
    let errors = 0;
    expect(() => recordAnswer({ ...base, post: f.post, onError: () => errors++ })).not.toThrow();
    f.releaseAll();
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toBe(1);
  });

  it("does not call onError when everything succeeds", async () => {
    const f = makePost();
    let errors = 0;
    recordAnswer({ ...base, post: f.post, onError: () => errors++ });
    f.releaseAll();
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toBe(0);
  });
});
