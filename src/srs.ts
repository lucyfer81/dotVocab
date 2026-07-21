export interface SrsState {
  reps: number;
  interval_days: number;
  due_at: number;
  lapses: number;
  last_reviewed_at: number | null;
}

export const INTERVALS_DAYS = [0, 1, 2, 4, 8, 16, 30, 60];
export const MASTERY_REPS = 3; // reps >= this => "已掌握" for display

const DAY_MS = 86_400_000;

export function emptyState(now: number): SrsState {
  return { reps: 0, interval_days: 0, due_at: now, lapses: 0, last_reviewed_at: null };
}

export function updateSrs(prev: SrsState, correct: boolean, now: number): SrsState {
  if (correct) {
    const reps = prev.reps + 1;
    const idx = Math.min(reps, INTERVALS_DAYS.length - 1);
    return {
      reps,
      interval_days: INTERVALS_DAYS[idx],
      due_at: now + INTERVALS_DAYS[idx] * DAY_MS,
      lapses: prev.lapses,
      last_reviewed_at: now,
    };
  }
  return {
    reps: 0,
    interval_days: 0,
    due_at: now,
    lapses: prev.lapses + 1,
    last_reviewed_at: now,
  };
}
