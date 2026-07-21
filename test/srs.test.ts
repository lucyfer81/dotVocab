import { describe, it, expect } from "vitest";
import { updateSrs, emptyState, INTERVALS_DAYS, MASTERY_REPS } from "../src/srs";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

describe("updateSrs", () => {
  it("first correct moves from due-now to interval[1] = 1 day", () => {
    const next = updateSrs(emptyState(NOW), true, NOW);
    expect(next.reps).toBe(1);
    expect(next.interval_days).toBe(INTERVALS_DAYS[1]);
    expect(next.due_at).toBe(NOW + INTERVALS_DAYS[1] * DAY);
    expect(next.lapses).toBe(0);
  });

  it("progresses through the interval ladder on consecutive corrects", () => {
    let s = emptyState(NOW);
    for (let i = 1; i <= 5; i++) {
      s = updateSrs(s, true, NOW + i * DAY);
      expect(s.reps).toBe(i);
      expect(s.interval_days).toBe(INTERVALS_DAYS[Math.min(i, INTERVALS_DAYS.length - 1)]);
    }
  });

  it("caps interval at the last ladder value", () => {
    let s = emptyState(NOW);
    for (let i = 0; i < 50; i++) s = updateSrs(s, true, NOW + i * DAY);
    expect(s.interval_days).toBe(INTERVALS_DAYS[INTERVALS_DAYS.length - 1]);
  });

  it("wrong resets reps to 0, due now, increments lapses", () => {
    let s = updateSrs(emptyState(NOW), true, NOW);
    const before = s.lapses;
    s = updateSrs(s, false, NOW + DAY);
    expect(s.reps).toBe(0);
    expect(s.interval_days).toBe(0);
    expect(s.due_at).toBe(NOW + DAY);
    expect(s.lapses).toBe(before + 1);
  });

  it("MASTERY_REPS is a sane threshold (>=3)", () => {
    expect(MASTERY_REPS).toBeGreaterThanOrEqual(3);
  });
});
