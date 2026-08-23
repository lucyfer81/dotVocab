import { describe, it, expect } from "vitest";
import { countGraduated } from "../public/mistake-helpers.js";

const q = (id: number, lapses: number, reps: number) => ({ id, lapses, reps });

describe("countGraduated", () => {
  it("counts words in-book at start whose final reps >= 2", () => {
    const queue = [q(1, 2, 0), q(2, 1, 1), q(3, 0, 0)]; // 3 是新词, 不算
    const finals = { 1: { reps: 2 }, 2: { reps: 2 }, 3: { reps: 2 } };
    expect(countGraduated(queue, finals)).toBe(2);
  });

  it("final reps 1 (not graduated) does not count", () => {
    const queue = [q(1, 1, 0)];
    expect(countGraduated(queue, { 1: { reps: 1 } })).toBe(0);
  });

  it("words with no successful report (net failure) do not count", () => {
    const queue = [q(1, 1, 0), q(2, 1, 0)];
    expect(countGraduated(queue, { 2: { reps: 3 } })).toBe(1);
  });

  it("empty queue / empty finals => 0", () => {
    expect(countGraduated([], {})).toBe(0);
    expect(countGraduated([q(1, 1, 0)], {})).toBe(0);
  });

  it("a word already graduated at session start is excluded", () => {
    const queue = [q(4, 1, 2)]; // lapses>0 but reps>=2: not in book at start
    expect(countGraduated(queue, { 4: { reps: 3 } })).toBe(0);
  });
});
