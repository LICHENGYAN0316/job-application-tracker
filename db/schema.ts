import {
  createAgentActionEventsTableSql,
  createAgentActionProposalsTableSql,
} from '../app/lib/agent-actions.server.ts';

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

export async function ensureCloudSchema(database: D1Database) {
  await database.prepare(createApplicationStatesTableSql).run();
  const columns = await database.prepare('PRAGMA table_info(application_states)').all<{ name: string }>();
  const names = new Set((columns.results ?? []).map((column) => column.name));
  if (!names.has('version')) {
    try {
      await database.prepare("ALTER TABLE application_states ADD COLUMN version TEXT NOT NULL DEFAULT ''").run();
    } catch (error) {
      if (!String(error).toLowerCase().includes('duplicate column')) throw error;
    }
  }
  if (!names.has('deleted_at')) {
    try {
      await database.prepare('ALTER TABLE application_states ADD COLUMN deleted_at TEXT').run();
    } catch (error) {
      if (!String(error).toLowerCase().includes('duplicate column')) throw error;
    }
  }

  await database.prepare(createGithubOauthStatesTableSql).run();
  await database.prepare(createGithubSessionsTableSql).run();
  await database.prepare('CREATE INDEX IF NOT EXISTS github_oauth_states_expires_idx ON github_oauth_states(expires_at_ms)').run();
  await database.prepare('CREATE INDEX IF NOT EXISTS github_sessions_account_idx ON github_sessions(account_key, expires_at_ms)').run();
  await database.prepare('CREATE INDEX IF NOT EXISTS github_sessions_expires_idx ON github_sessions(expires_at_ms)').run();
  await database.prepare(createAgentUsersTableSql).run();
  const agentUserColumns = await database.prepare('PRAGMA table_info(agent_users)').all<{ name: string }>();
  const agentUserColumnNames = new Set((agentUserColumns.results ?? []).map((column) => column.name));
  if (!agentUserColumnNames.has('quota_override')) {
    try {
      await database.prepare(
        'ALTER TABLE agent_users ADD COLUMN quota_override INTEGER CHECK (quota_override IS NULL OR quota_override BETWEEN 0 AND 100)',
      ).run();
    } catch (error) {
      if (!String(error).toLowerCase().includes('duplicate column')) throw error;
    }
  }
  await database.prepare(createAgentSettingsTableSql).run();
  const agentSettingColumns = await database.prepare('PRAGMA table_info(agent_settings)').all<{ name: string }>();
  const agentSettingColumnNames = new Set((agentSettingColumns.results ?? []).map((column) => column.name));
  if (!agentSettingColumnNames.has('default_daily_limit')) {
    try {
      await database.prepare(
        'ALTER TABLE agent_settings ADD COLUMN default_daily_limit INTEGER NOT NULL DEFAULT 5 CHECK (default_daily_limit BETWEEN 0 AND 100)',
      ).run();
    } catch (error) {
      if (!String(error).toLowerCase().includes('duplicate column')) throw error;
    }
  }
  await database.prepare(`
    INSERT OR IGNORE INTO agent_settings
      (id, global_enabled, default_daily_limit, version, updated_at_ms, updated_by_account_key)
    VALUES (1, 0, 5, 1, 0, '')
  `).run();
  await database.prepare(createAgentCallsTableSql).run();
  const agentCallColumns = await database.prepare('PRAGMA table_info(agent_calls)').all<{ name: string }>();
  const agentCallColumnNames = new Set((agentCallColumns.results ?? []).map((column) => column.name));
  const missingAgentCallColumns: Array<[string, string]> = [
    ['session_id', "ALTER TABLE agent_calls ADD COLUMN session_id TEXT NOT NULL DEFAULT ''"],
    ['latency_ms', 'ALTER TABLE agent_calls ADD COLUMN latency_ms INTEGER NOT NULL DEFAULT 0'],
    ['feedback', "ALTER TABLE agent_calls ADD COLUMN feedback TEXT CHECK (feedback IN ('resolved', 'unresolved'))"],
    ['feedback_at_ms', 'ALTER TABLE agent_calls ADD COLUMN feedback_at_ms INTEGER'],
  ];
  for (const [name, query] of missingAgentCallColumns) {
    if (!agentCallColumnNames.has(name)) {
      try {
        await database.prepare(query).run();
      } catch (error) {
        if (!String(error).toLowerCase().includes('duplicate column')) throw error;
      }
    }
  }
  await database.prepare('CREATE INDEX IF NOT EXISTS agent_calls_quota_idx ON agent_calls(account_key, status, completed_at_ms, reservation_expires_at_ms)').run();
  await database.prepare('CREATE INDEX IF NOT EXISTS agent_calls_completed_idx ON agent_calls(completed_at_ms)').run();
  await database.prepare('CREATE INDEX IF NOT EXISTS agent_calls_session_idx ON agent_calls(account_key, session_id, status)').run();
  await database.prepare(createAgentRequestEventsTableSql).run();
  await database.prepare('CREATE INDEX IF NOT EXISTS agent_request_events_created_idx ON agent_request_events(created_at_ms)').run();
  await database.prepare(createAgentActionProposalsTableSql).run();
  const actionProposalSchema = await database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_action_proposals'",
  ).first<{ sql?: string }>();
  if (actionProposalSchema?.sql && !actionProposalSchema.sql.includes("'update_job'")) {
    const createNextTableSql = createAgentActionProposalsTableSql
      .replace('CREATE TABLE IF NOT EXISTS agent_action_proposals', 'CREATE TABLE agent_action_proposals_next');
    const migrateStatements = [
      database.prepare('DROP TABLE IF EXISTS agent_action_proposals_next'),
      database.prepare(createNextTableSql),
      database.prepare(`
        INSERT OR IGNORE INTO agent_action_proposals_next (
          id, account_key, session_id, source_call_id, idempotency_key, action_kind,
          base_state_version, target_company_id, target_job_id, target_fingerprint,
          payload_json, confirmation_nonce_hash, status, created_at_ms, expires_at_ms,
          confirmed_at_ms, completed_at_ms, execution_lease_expires_at_ms,
          execution_idempotency_key, result_state_version, failure_code, feedback, feedback_at_ms
        )
        SELECT
          id, account_key, session_id, source_call_id, idempotency_key, action_kind,
          base_state_version, target_company_id, target_job_id, target_fingerprint,
          payload_json, confirmation_nonce_hash, status, created_at_ms, expires_at_ms,
          confirmed_at_ms, completed_at_ms, execution_lease_expires_at_ms,
          execution_idempotency_key, result_state_version, failure_code, feedback, feedback_at_ms
        FROM agent_action_proposals
      `),
      database.prepare('DROP TABLE agent_action_proposals'),
      database.prepare('ALTER TABLE agent_action_proposals_next RENAME TO agent_action_proposals'),
    ];
    try {
      await database.batch(migrateStatements);
    } catch (error) {
      const refreshed = await database.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_action_proposals'",
      ).first<{ sql?: string }>();
      if (!refreshed?.sql?.includes("'update_job'")) throw error;
    }
  }
  await database.prepare(createAgentActionEventsTableSql).run();
  await database.prepare('CREATE INDEX IF NOT EXISTS agent_action_proposals_account_idx ON agent_action_proposals(account_key, status, expires_at_ms)').run();
  await database.prepare('CREATE INDEX IF NOT EXISTS agent_action_events_created_idx ON agent_action_events(created_at_ms)').run();
}

let cloudSchemaReady: Promise<void> | null = null;

export function ensureCloudSchemaOnce(database: D1Database) {
  if (!cloudSchemaReady) {
    cloudSchemaReady = ensureCloudSchema(database).catch((error) => {
      cloudSchemaReady = null;
      throw error;
    });
  }
  return cloudSchemaReady;
}
