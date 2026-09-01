CREATE TABLE IF NOT EXISTS github_oauth_states (
  state_hash TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS github_sessions (
  session_hash TEXT PRIMARY KEY,
  account_key TEXT NOT NULL,
  github_subject TEXT NOT NULL,
  display_login TEXT NOT NULL DEFAULT '',
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS github_oauth_states_expires_idx
  ON github_oauth_states(expires_at_ms);

CREATE INDEX IF NOT EXISTS github_sessions_account_idx
  ON github_sessions(account_key, expires_at_ms);

CREATE INDEX IF NOT EXISTS github_sessions_expires_idx
  ON github_sessions(expires_at_ms);

CREATE TABLE IF NOT EXISTS agent_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_key TEXT NOT NULL UNIQUE,
  auth_provider TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  quota_override INTEGER CHECK (quota_override IS NULL OR quota_override BETWEEN 0 AND 100),
  created_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  global_enabled INTEGER NOT NULL DEFAULT 0 CHECK (global_enabled IN (0, 1)),
  default_daily_limit INTEGER NOT NULL DEFAULT 5 CHECK (default_daily_limit BETWEEN 0 AND 100),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at_ms INTEGER NOT NULL DEFAULT 0,
  updated_by_account_key TEXT NOT NULL DEFAULT ''
);

INSERT OR IGNORE INTO agent_settings
  (id, global_enabled, default_daily_limit, version, updated_at_ms, updated_by_account_key)
VALUES (1, 0, 5, 1, 0, '');

CREATE TABLE IF NOT EXISTS agent_calls (
  id TEXT PRIMARY KEY,
  account_key TEXT NOT NULL,
  auth_provider TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  idempotency_key TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('reserved', 'success', 'technical_failure')),
  reserved_at_ms INTEGER NOT NULL,
  reservation_expires_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  model TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_micro_cny INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  feedback TEXT CHECK (feedback IN ('resolved', 'unresolved')),
  feedback_at_ms INTEGER,
  error_class TEXT,
  UNIQUE(account_key, idempotency_key)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS agent_calls_quota_idx
  ON agent_calls(account_key, status, completed_at_ms, reservation_expires_at_ms);

CREATE INDEX IF NOT EXISTS agent_calls_completed_idx
  ON agent_calls(completed_at_ms);

CREATE INDEX IF NOT EXISTS agent_calls_session_idx
  ON agent_calls(account_key, session_id, status);

CREATE TABLE IF NOT EXISTS agent_request_events (
  id TEXT PRIMARY KEY,
  account_key TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  valid INTEGER NOT NULL CHECK (valid IN (0, 1)),
  created_at_ms INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS agent_request_events_created_idx
  ON agent_request_events(created_at_ms);

CREATE TABLE IF NOT EXISTS agent_action_proposals (
  id TEXT PRIMARY KEY,
  account_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_call_id TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL,
  action_kind TEXT NOT NULL CHECK (
    action_kind IN ('add_company', 'add_job', 'delete_company', 'delete_job')
  ),
  base_state_version TEXT NOT NULL,
  target_company_id TEXT NOT NULL DEFAULT '',
  target_job_id TEXT NOT NULL DEFAULT '',
  target_fingerprint TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  confirmation_nonce_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'awaiting_confirmation', 'executing', 'executed', 'cancelled',
      'expired', 'conflict', 'failed'
    )
  ),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  confirmed_at_ms INTEGER,
  completed_at_ms INTEGER,
  execution_lease_expires_at_ms INTEGER,
  execution_idempotency_key TEXT NOT NULL DEFAULT '',
  result_state_version TEXT NOT NULL DEFAULT '',
  failure_code TEXT NOT NULL DEFAULT '',
  feedback TEXT CHECK (feedback IN ('correct', 'incorrect')),
  feedback_at_ms INTEGER,
  UNIQUE(account_key, idempotency_key)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS agent_action_events (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL DEFAULT '',
  account_key TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  action_kind TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL,
  reason_code TEXT NOT NULL DEFAULT '',
  schema_valid INTEGER CHECK (schema_valid IN (0, 1)),
  ambiguity_detected INTEGER CHECK (ambiguity_detected IN (0, 1)),
  ambiguity_handled INTEGER CHECK (ambiguity_handled IN (0, 1)),
  parameter_exact INTEGER CHECK (parameter_exact IN (0, 1)),
  user_review_outcome TEXT CHECK (user_review_outcome IN ('correct', 'incorrect')),
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS agent_action_proposals_account_idx
  ON agent_action_proposals(account_key, status, expires_at_ms);

CREATE INDEX IF NOT EXISTS agent_action_events_created_idx
  ON agent_action_events(created_at_ms);
