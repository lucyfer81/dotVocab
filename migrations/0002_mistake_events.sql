-- 错拼事件（append-only 日志，不参与错题本判定；判定纯派生自 user_word_state）
CREATE TABLE IF NOT EXISTS wrong_answer_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  word_id INTEGER NOT NULL,
  answer TEXT,
  source TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wrong_events ON wrong_answer_events(user_id, word_id);
