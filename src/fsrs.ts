import { createEmptyCard, fsrs, Rating, State, type Card } from "ts-fsrs";

// 卡片状态 wire 格式："fsrs-v1:" + JSON。
// 字段名与 ts-fsrs 的 Card 一致；日期字段（due / last_review）存 epoch 毫秒，
// 反序列化时还原成库需要的 Date。将来升级库版本或调度参数时，按前缀迁移旧状态。
const STATE_PREFIX = "fsrs-v1:";

export type CardRating = "Good" | "Again";

export interface AdvanceResult {
  state: string;
  dueMs: number;
}

function serializeCard(card: Card): string {
  const payload: Record<string, unknown> = {
    due: card.due.getTime(),
    stability: card.stability,
    difficulty: card.difficulty,
    scheduled_days: card.scheduled_days,
    reps: card.reps,
    lapses: card.lapses,
    learning_steps: card.learning_steps,
    state: card.state,
  };
  if (card.last_review) payload.last_review = card.last_review.getTime();
  return STATE_PREFIX + JSON.stringify(payload);
}

function deserializeState(state: string): Card {
  if (!state.startsWith(STATE_PREFIX)) {
    throw new Error(
      `fsrs: unknown state format (expected "${STATE_PREFIX}"): ${state.slice(0, 24)}`,
    );
  }
  const raw = JSON.parse(state.slice(STATE_PREFIX.length)) as Record<string, unknown>;
  const card: Card = {
    due: new Date(raw.due as number),
    stability: raw.stability as number,
    difficulty: raw.difficulty as number,
    scheduled_days: raw.scheduled_days as number,
    reps: raw.reps as number,
    lapses: raw.lapses as number,
    learning_steps: raw.learning_steps as number,
    state: raw.state as State,
    last_review: raw.last_review != null ? new Date(raw.last_review as number) : undefined,
  };
  return card;
}

// previous=null → 从库的空卡开始（不从旧 reps 伪造卡片）。
// 使用库默认调度参数；显式传入 nowMs，不使用库的默认"现在"。
export function advanceCard(
  previous: string | null,
  rating: CardRating,
  nowMs: number,
): AdvanceResult {
  const scheduler = fsrs();
  const card =
    previous === null ? createEmptyCard(new Date(nowMs)) : deserializeState(previous);
  const grade = rating === "Good" ? Rating.Good : Rating.Again;
  const next = scheduler.repeat(card, new Date(nowMs))[grade].card;
  return { state: serializeCard(next), dueMs: next.due.getTime() };
}
