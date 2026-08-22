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

describe("updateSrs: lapse recovery (订正后不能和一次做对一样)", () => {
  it("first correct after a wrong stays due now (same-day reinforcement)", () => {
    let s = updateSrs(emptyState(NOW), true, NOW);
    s = updateSrs(s, false, NOW + DAY);
    const corrected = updateSrs(s, true, NOW + DAY + 60_000);
    expect(corrected.reps).toBe(1);
    expect(corrected.interval_days).toBe(0);
    expect(corrected.due_at).toBe(NOW + DAY + 60_000);
    expect(corrected.lapses).toBe(1);
  });

  it("lapsed word climbs the ladder one step behind a fresh word", () => {
    let s = updateSrs(emptyState(NOW), false, NOW);
    s = updateSrs(s, true, NOW + 1_000);   // recovering correct: 0 days
    expect(s.interval_days).toBe(INTERVALS_DAYS[0]);
    s = updateSrs(s, true, NOW + DAY);     // reps=2 → one rung behind fresh
    expect(s.interval_days).toBe(INTERVALS_DAYS[1]);
    s = updateSrs(s, true, NOW + 2 * DAY);
    expect(s.interval_days).toBe(INTERVALS_DAYS[2]);
  });

  it("lapsed word caps one rung below the max (permanent denser ladder)", () => {
    let s = updateSrs(emptyState(NOW), false, NOW);
    for (let i = 0; i < 60; i++) s = updateSrs(s, true, NOW + i * DAY);
    expect(s.interval_days).toBe(INTERVALS_DAYS[INTERVALS_DAYS.length - 2]);
  });

  it("lapse-free word keeps the original fast ladder (regression guard)", () => {
    let s = emptyState(NOW);
    s = updateSrs(s, true, NOW);
    expect(s.interval_days).toBe(INTERVALS_DAYS[1]);
    s = updateSrs(s, true, NOW + DAY);
    expect(s.interval_days).toBe(INTERVALS_DAYS[2]);
  });
});
