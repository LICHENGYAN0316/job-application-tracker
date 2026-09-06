export const createApplicationStatesTableSql = `
  CREATE TABLE IF NOT EXISTS application_states (
    user_id TEXT PRIMARY KEY,
    user_email TEXT NOT NULL DEFAULT '',
    data_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '',
    deleted_at TEXT
  ) WITHOUT ROWID
`;

export const createGithubOauthStatesTableSql = `
  CREATE TABLE IF NOT EXISTS github_oauth_states (
    state_hash TEXT PRIMARY KEY,
    code_verifier TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    consumed_at_ms INTEGER
  ) WITHOUT ROWID
`;

export const createGithubSessionsTableSql = `
  CREATE TABLE IF NOT EXISTS github_sessions (
    session_hash TEXT PRIMARY KEY,
    account_key TEXT NOT NULL,
    github_subject TEXT NOT NULL,
    display_login TEXT NOT NULL DEFAULT '',
    created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    revoked_at_ms INTEGER
  ) WITHOUT ROWID
`;

export const createAgentUsersTableSql = `
  CREATE TABLE IF NOT EXISTS agent_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_key TEXT NOT NULL UNIQUE,
    auth_provider TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
    quota_override INTEGER CHECK (quota_override IS NULL OR quota_override BETWEEN 0 AND 100),
    created_at_ms INTEGER NOT NULL,
    last_seen_at_ms INTEGER NOT NULL
  )
`;

export const createAgentSettingsTableSql = `
  CREATE TABLE IF NOT EXISTS agent_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    global_enabled INTEGER NOT NULL DEFAULT 0 CHECK (global_enabled IN (0, 1)),
    default_daily_limit INTEGER NOT NULL DEFAULT 5 CHECK (default_daily_limit BETWEEN 0 AND 100),
    version INTEGER NOT NULL DEFAULT 1,
    updated_at_ms INTEGER NOT NULL DEFAULT 0,
    updated_by_account_key TEXT NOT NULL DEFAULT ''
  )
`;

export const createAgentCallsTableSql = `
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
  ) WITHOUT ROWID
`;

export const createAgentRequestEventsTableSql = `
  CREATE TABLE IF NOT EXISTS agent_request_events (
    id TEXT PRIMARY KEY,
    account_key TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    valid INTEGER NOT NULL CHECK (valid IN (0, 1)),
    created_at_ms INTEGER NOT NULL
  ) WITHOUT ROWID
`;
