import { describe, it, expect } from "vitest";
// 被测适配器必须排第一：RED 阶段 src/fsrs.ts 不存在，解析应在此失败。
import { advanceCard } from "../src/fsrs";
import { fsrs, createEmptyCard, Rating, State, type Grade } from "ts-fsrs";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const STATE_PREFIX = "fsrs-v1:";

type LibCard = ReturnType<typeof createEmptyCard>;

// 基准：直接调库（默认参数 + 显式固定时间），与适配器互为独立实现。
// repeat 返回按 Grade（Again|Hard|Good|Easy）索引的 RecordLog。
function scheduleLib(card: LibCard, nowMs: number, rating: Grade): LibCard {
  return fsrs().repeat(card, new Date(nowMs))[rating].card;
}

// wire 契约：state = "fsrs-v1:" + JSON（字段名沿用 ts-fsrs Card，日期为 epoch 毫秒）。
function payloadOf(state: string): Record<string, unknown> {
  expect(state.startsWith(STATE_PREFIX)).toBe(true);
  return JSON.parse(state.slice(STATE_PREFIX.length)) as Record<string, unknown>;
}

function expectCardFields(payload: Record<string, unknown>, card: LibCard): void {
  expect(payload.due).toBe(card.due.getTime());
  expect(payload.reps).toBe(card.reps);
  expect(payload.lapses).toBe(card.lapses);
  expect(payload.learning_steps).toBe(card.learning_steps);
  expect(payload.state).toBe(card.state);
  // 注：ts-fsrs 6 的 Card 无 elapsed_days——repeat 内部从 last_review 现算，wire 格式不含它。
  expect(payload.scheduled_days).toBe(card.scheduled_days);
  expect(payload.stability).toBe(card.stability);
  expect(payload.difficulty).toBe(card.difficulty);
}

describe("advanceCard: 空卡首次调度（与所锁 ts-fsrs 默认结果相等）", () => {
  it("first Good from null matches library default schedule", () => {
    const expected = scheduleLib(createEmptyCard(new Date(NOW)), NOW, Rating.Good);
    const got = advanceCard(null, "Good", NOW);
    expect(got.dueMs).toBe(expected.due.getTime());
    const payload = payloadOf(got.state);
    expect(payload.due).toBe(got.dueMs);
    expectCardFields(payload, expected);
  });

  it("first Again from null matches library default schedule", () => {
    const expected = scheduleLib(createEmptyCard(new Date(NOW)), NOW, Rating.Again);
    const got = advanceCard(null, "Again", NOW);
    expect(got.dueMs).toBe(expected.due.getTime());
    expectCardFields(payloadOf(got.state), expected);
  });

  it("uses the explicit nowMs, not the real clock (deterministic)", () => {
    const a = advanceCard(null, "Good", NOW);
    const b = advanceCard(null, "Good", NOW);
    expect(a.state).toBe(b.state);
    expect(a.dueMs).toBe(b.dueMs);
    expect(a.dueMs).toBeGreaterThan(NOW); // 首次 Good 间隔为正
  });
});

describe("advanceCard: 序列化往返后复习与连续调用结果一致", () => {
  it("round-trip then Good equals the continuous in-memory path", () => {
    // 连续路径：全程在内存里推进，不经过 state 字符串。
    const c1 = scheduleLib(createEmptyCard(new Date(NOW)), NOW, Rating.Good);
    const c2 = scheduleLib(c1, NOW + DAY, Rating.Good);

    // 序列化路径：第一跳结果经 state 字符串往返后继续。
    const s1 = advanceCard(null, "Good", NOW);
    const s2 = advanceCard(s1.state, "Good", NOW + DAY);

    expect(s2.dueMs).toBe(c2.due.getTime());
    expectCardFields(payloadOf(s2.state), c2);
  });

  it("round-trip then Again in learning state (no lapse) equals the continuous in-memory path", () => {
    // 注意：New→Good 产出 Learning 卡（默认 learning steps ['1m','10m']），
    // 此处 Again 走 learningState 路径——不加 lapses、不进 Relearning，不是真遗忘。
    const c1 = scheduleLib(createEmptyCard(new Date(NOW)), NOW, Rating.Good);
    const c2 = scheduleLib(c1, NOW + DAY, Rating.Again);

    const s1 = advanceCard(null, "Good", NOW);
    const s2 = advanceCard(s1.state, "Again", NOW + DAY);

    expect(s2.dueMs).toBe(c2.due.getTime());
    expectCardFields(payloadOf(s2.state), c2);
  });

  it("round-trip through a real lapse (Review -> Again) equals the continuous in-memory path", () => {
    // 三跳才到真遗忘：New→Good 进 Learning；Learning 中 Good 走完 steps 毕业
    // 进 Review；Review 态 Again 才走 reviewState（lapses+1、Relearning）。
    const c0 = createEmptyCard(new Date(NOW));
    const c1 = scheduleLib(c0, NOW, Rating.Good);
    const c2 = scheduleLib(c1, NOW + DAY, Rating.Good);
    const c3 = scheduleLib(c2, NOW + 5 * DAY, Rating.Again);

    // 序列化路径：每一跳都经 state 字符串往返后继续。
    const s1 = advanceCard(null, "Good", NOW);
    const s2 = advanceCard(s1.state, "Good", NOW + DAY);
    const s3 = advanceCard(s2.state, "Again", NOW + 5 * DAY);

    expect(s3.dueMs).toBe(c3.due.getTime());
    expectCardFields(payloadOf(s3.state), c3);
    // 前提守卫：确认库确实走了 reviewState 真遗忘路径（否则本用例前提失效）。
    expect(c2.state).toBe(State.Review);
    expect(c3.lapses).toBe(1);
    expect(c3.state).toBe(State.Relearning);
  });

  it("same input state + same nowMs => identical output (no hidden mutation)", () => {
    const s1 = advanceCard(null, "Again", NOW);
    const a = advanceCard(s1.state, "Good", NOW + DAY);
    const b = advanceCard(s1.state, "Good", NOW + DAY);
    expect(a.state).toBe(b.state);
    expect(a.dueMs).toBe(b.dueMs);
  });
});
