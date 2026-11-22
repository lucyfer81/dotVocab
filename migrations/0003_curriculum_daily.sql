CREATE TABLE curriculum_units (
  id INTEGER PRIMARY KEY,
  book TEXT NOT NULL,
  book_title TEXT NOT NULL,
  book_order INTEGER NOT NULL,
  unit INTEGER NOT NULL,
  UNIQUE(book, unit)
);
CREATE TABLE curriculum_senses (
  sense_id TEXT PRIMARY KEY NOT NULL,
  term TEXT NOT NULL,
  meaning TEXT NOT NULL,
  accepted_json TEXT NOT NULL
);
CREATE TABLE curriculum_unit_senses (
  unit_id INTEGER NOT NULL REFERENCES curriculum_units(id),
  sense_id TEXT NOT NULL REFERENCES curriculum_senses(sense_id),
  row_order INTEGER NOT NULL,
  PRIMARY KEY(unit_id, sense_id)
);
CREATE TABLE pool_units (
  unit_id INTEGER PRIMARY KEY REFERENCES curriculum_units(id)
);
CREATE TABLE user_quotas (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  daily_limit INTEGER NOT NULL DEFAULT 10 CHECK(daily_limit IN (10,15,20))
);
CREATE TABLE user_cards (
  user_id INTEGER NOT NULL REFERENCES users(id),
  sense_id TEXT NOT NULL REFERENCES curriculum_senses(sense_id),
  due_at INTEGER NOT NULL,
  card_json TEXT NOT NULL,
  PRIMARY KEY(user_id, sense_id)
);
CREATE INDEX idx_user_cards_due ON user_cards(user_id, due_at, sense_id);
CREATE TABLE daily_lists (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  study_date TEXT NOT NULL,
  daily_limit INTEGER NOT NULL CHECK(daily_limit IN (10,15,20)),
  generation_token TEXT NOT NULL,
  UNIQUE(user_id, study_date)
);
CREATE TABLE daily_items (
  id INTEGER PRIMARY KEY,
  list_id INTEGER NOT NULL REFERENCES daily_lists(id) ON DELETE CASCADE,
  sense_id TEXT NOT NULL REFERENCES curriculum_senses(sense_id),
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('new','due')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','correction','done')),
  first_event_id TEXT,
  UNIQUE(list_id, sense_id),
  UNIQUE(list_id, position)
);
CREATE TABLE answer_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  sense_id TEXT NOT NULL REFERENCES curriculum_senses(sense_id),
  item_id INTEGER REFERENCES daily_items(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  action TEXT NOT NULL,
  answer TEXT,
  correct INTEGER NOT NULL CHECK(correct IN (0,1)),
  created_at INTEGER NOT NULL,
  rating TEXT,
  card_before_json TEXT,
  card_after_json TEXT,
  result_json TEXT
);
-- One-time D1 cutover
DELETE FROM user_word_state;
DELETE FROM user_unit_word_seen;
DELETE FROM wrong_answer_events;
DELETE FROM user_stats;
