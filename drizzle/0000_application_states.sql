CREATE TABLE IF NOT EXISTS application_states (
  user_id TEXT PRIMARY KEY,
  user_email TEXT NOT NULL DEFAULT '',
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;
