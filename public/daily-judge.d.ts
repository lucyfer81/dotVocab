export function normalizeDailyAnswer(action: "spell" | "reveal", answer: string | null): string | null;
export function parseDailySpellings(json: string): string[];
export function matchesDailySpelling(normalizedAnswer: string | null, spellings: string[]): boolean;
