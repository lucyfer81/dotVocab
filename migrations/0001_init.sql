-- 课本单元
CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book TEXT NOT NULL,
  unit TEXT NOT NULL,
  sort_key INTEGER DEFAULT 0,
  UNIQUE(book, unit)
);

-- 单词（规范化去重）
CREATE TABLE IF NOT EXISTS words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT NOT NULL UNIQUE,
  pos TEXT,
  meaning_cn TEXT NOT NULL,
  example_en TEXT,
  example_cn TEXT,
  created_at INTEGER NOT NULL
);

-- 单元↔单词 多对多
CREATE TABLE IF NOT EXISTS unit_words (
  unit_id INTEGER NOT NULL,
  word_id INTEGER NOT NULL,
  PRIMARY KEY (unit_id, word_id)
);

-- 两个孩子
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  avatar TEXT NOT NULL,
  pin TEXT
);

-- 第①层 全局 SRS 状态
CREATE TABLE IF NOT EXISTS user_word_state (
  user_id INTEGER NOT NULL,
  word_id INTEGER NOT NULL,
  reps INTEGER DEFAULT 0,
  interval_days INTEGER DEFAULT 0,
  due_at INTEGER DEFAULT 0,
  lapses INTEGER DEFAULT 0,
  last_reviewed_at INTEGER,
  PRIMARY KEY (user_id, word_id)
);

-- 第②层 单元内覆盖记录
CREATE TABLE IF NOT EXISTS user_unit_word_seen (
  user_id INTEGER NOT NULL,
  unit_id INTEGER NOT NULL,
  word_id INTEGER NOT NULL,
  first_seen_at INTEGER,
  PRIMARY KEY (user_id, unit_id, word_id)
);

-- 星星 / 连击
CREATE TABLE IF NOT EXISTS user_stats (
  user_id INTEGER PRIMARY KEY,
  stars INTEGER DEFAULT 0,
  streak_days INTEGER DEFAULT 0,
  last_play_date TEXT
);

-- 预置两个孩子
INSERT OR IGNORE INTO users (name, avatar) VALUES ('哥哥', '👦');
INSERT OR IGNORE INTO users (name, avatar) VALUES ('弟弟', '👶');
