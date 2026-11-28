import { dayStr } from "./daily-list";
import { cardStage, type CardRating } from "./fsrs";

export const POOL_SENSES_SQL = `
  SELECT DISTINCT x.sense_id
  FROM pool_units p JOIN curriculum_unit_senses x ON x.unit_id = p.unit_id`;

interface Location {
  unitId: number;
  book: string;
  bookTitle: string;
  bookOrder: number;
  unit: number;
  open: boolean;
}

interface VocabularyEntry {
  senseId: string;
  term: string;
  meaning: string;
  stage: "not_started" | ReturnType<typeof cardStage>;
  dueOn: string | null;
  lastRating: CardRating | null;
  locations: Location[];
}

export async function readVocabulary(db: D1Database, userId: number) {
  const { results } = await db.prepare(`
    WITH pool_senses AS (${POOL_SENSES_SQL}),
    grades AS (
      SELECT e.sense_id, e.rating,
             ROW_NUMBER() OVER (PARTITION BY e.sense_id ORDER BY e.created_at DESC, e.rowid DESC) AS latest
      FROM answer_events e JOIN pool_senses p ON p.sense_id = e.sense_id
      WHERE e.user_id = ?1 AND e.source = 'daily' AND e.rating IN ('Good', 'Again')
    )
    SELECT s.sense_id AS senseId, s.term, s.meaning, c.card_json AS cardState, c.due_at AS dueAt,
           g.rating AS lastRating, u.id AS unitId, u.book, u.book_title AS bookTitle,
           u.book_order AS bookOrder, u.unit,
           p.unit_id IS NOT NULL AS open
    FROM pool_senses ps
    JOIN curriculum_senses s ON s.sense_id = ps.sense_id
    JOIN curriculum_unit_senses x ON x.sense_id = s.sense_id
    JOIN curriculum_units u ON u.id = x.unit_id
    LEFT JOIN pool_units p ON p.unit_id = u.id
    LEFT JOIN user_cards c ON c.user_id = ?1 AND c.sense_id = s.sense_id
    LEFT JOIN grades g ON g.sense_id = c.sense_id AND g.latest = 1
    ORDER BY u.book_order, u.book, u.unit, x.row_order, s.sense_id`
  ).bind(userId).all<Omit<Location, "open"> & {
    senseId: string; term: string; meaning: string; open: number;
    cardState: string | null; dueAt: number | null; lastRating: CardRating | null;
  }>();

  const entries = new Map<string, VocabularyEntry>();
  for (const { senseId, term, meaning, cardState, dueAt, lastRating, open, ...location } of results) {
    let entry = entries.get(senseId);
    if (!entry) {
      entry = {
        senseId, term, meaning, lastRating,
        stage: cardState === null ? "not_started" : cardStage(cardState),
        dueOn: dueAt === null || !Number.isFinite(new Date(dueAt).getTime()) ? null : dayStr(dueAt),
        locations: [],
      };
      entries.set(senseId, entry);
    }
    entry.locations.push({ ...location, open: Boolean(open) });
  }
  return [...entries.values()];
}
