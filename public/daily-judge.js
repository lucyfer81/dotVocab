export function normalizeDailyAnswer(action, answer) {
  return action === "spell" && answer != null
    ? answer.trim().toLowerCase().slice(0, 100)
    : null;
}

export function parseDailySpellings(json) {
  try {
    const values = JSON.parse(json);
    return Array.isArray(values) ? values.filter((value) => typeof value === "string") : [];
  } catch {
    return [];
  }
}

export function matchesDailySpelling(normalizedAnswer, spellings) {
  return normalizedAnswer != null && spellings.some(
    (spelling) => spelling.trim().toLowerCase() === normalizedAnswer,
  );
}
