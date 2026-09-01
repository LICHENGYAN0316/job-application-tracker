import assert from 'node:assert/strict';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import test from 'node:test';
import {
  createAgentCallsTableSql,
  createAgentSettingsTableSql,
  createAgentUsersTableSql,
} from '../../db/schema.ts';
import {
  createAgentActionEventsTableSql,
  createAgentActionProposalsTableSql,
} from './agent-actions.server.ts';
import { readAgentAdminDashboard } from './agent-admin.server.ts';
import type { AgentDatabase, AgentRuntimeConfig } from './agent-service.server.ts';
import type { AuthPrincipal } from './auth-principal.server.ts';

class SqliteStatement {
  private values: unknown[] = [];
  private readonly statement: StatementSync;

  constructor(statement: StatementSync) {
    this.statement = statement;
  }

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>() {
    return (this.statement.get(...this.values as never[]) ?? null) as T | null;
  }

  async all<T>() {
    return { results: this.statement.all(...this.values as never[]) as T[] };
  }

  async run() {
    const result = this.statement.run(...this.values as never[]);
    return { meta: { changes: Number(result.changes) } };
  }
}

class SqliteAgentDatabase {
  readonly raw = new DatabaseSync(':memory:');

  prepare(query: string) {
    return new SqliteStatement(this.raw.prepare(query)) as unknown as ReturnType<AgentDatabase['prepare']>;
  }
}

const ADMIN: AuthPrincipal = {
  id: 'owner-id',
  email: 'owner@example.com',
  provider: 'chatgpt',
  subject: 'owner-id',
  displayName: 'owner@example.com',
};

const CONFIG: AgentRuntimeConfig = {
  apiKey: 'test-only',
  model: 'test-model',
  adminChatgptUserId: ADMIN.subject,
};

test('real SQLite query merges action feedback and excludes legacy zero-latency rows', async () => {
  const database = new SqliteAgentDatabase();
  try {
    database.raw.exec(createAgentUsersTableSql);
    database.raw.exec(createAgentSettingsTableSql);
    database.raw.exec(createAgentCallsTableSql);
    database.raw.exec(createAgentActionProposalsTableSql);
    database.raw.exec(createAgentActionEventsTableSql);
    database.raw.exec(`
      INSERT INTO agent_settings
        (id, global_enabled, default_daily_limit, version, updated_at_ms, updated_by_account_key)
      VALUES (1, 1, 5, 1, 0, '');
      INSERT INTO agent_users
        (account_key, auth_provider, role, disabled, created_at_ms, last_seen_at_ms)
      VALUES ('user-a', 'chatgpt', 'user', 0, 1, 1);
      INSERT INTO agent_calls
        (id, account_key, auth_provider, is_admin, idempotency_key, session_id, status,
         reserved_at_ms, reservation_expires_at_ms, completed_at_ms, model,
         total_tokens, estimated_cost_micro_cny, latency_ms, feedback, feedback_at_ms)
      VALUES
        ('call-action', 'user-a', 'chatgpt', 0, 'idem-a', 'session-action', 'success',
         10, 20, 30, 'model', 20, 100, 100, NULL, NULL),
        ('call-analysis', 'user-a', 'chatgpt', 0, 'idem-b', 'session-analysis', 'success',
         11, 21, 31, 'model', 30, 200, 0, 'resolved', 32),
        ('call-failed', 'user-a', 'chatgpt', 0, 'idem-c', 'session-failed', 'technical_failure',
         12, 22, 32, 'model', 0, 0, 0, NULL, NULL);
      INSERT INTO agent_action_proposals
        (id, account_key, session_id, source_call_id, idempotency_key, action_kind,
         base_state_version, confirmation_nonce_hash, status, created_at_ms, expires_at_ms,
         confirmed_at_ms, completed_at_ms, feedback, feedback_at_ms)
      VALUES
        ('proposal-a', 'user-a', 'session-action', 'call-action', 'proposal-idem-a', 'add_company',
         'version-a', 'nonce-hash', 'executed', 10, 600010, 20, 30, 'correct', 31);
      INSERT INTO agent_action_events
        (id, proposal_id, account_key, session_id, action_kind, event_type, schema_valid, created_at_ms)
      VALUES
        ('event-ready', 'proposal-a', 'user-a', 'session-action', 'add_company', 'proposal_ready', 1, 10),
        ('event-confirm', 'proposal-a', 'user-a', 'session-action', 'add_company', 'confirmation_attempted', NULL, 20),
        ('event-confirm-replay', 'proposal-a', 'user-a', 'session-action', 'add_company', 'confirmation_attempted', NULL, 21),
        ('event-started', 'proposal-a', 'user-a', 'session-action', 'add_company', 'execution_started', NULL, 22),
        ('event-executed', 'proposal-a', 'user-a', 'session-action', 'add_company', 'executed', NULL, 30);
    `);

    const dashboard = await readAgentAdminDashboard(
      database as unknown as AgentDatabase,
      ADMIN,
      CONFIG,
      1_000_000,
    );

    assert.equal(dashboard.quality.technicalSuccessRate, 2 / 3);
    assert.equal(dashboard.quality.taskSuccessRate, 1);
    assert.equal(dashboard.quality.ratedTasks, 2);
    assert.equal(dashboard.quality.oneRoundResolutionRate, 1);
    assert.equal(dashboard.quality.feedbackCoverageRate, 1);
    assert.equal(dashboard.quality.averageCompletedRounds, 1);
    assert.equal(dashboard.quality.latencySamples, 1);
    assert.equal(dashboard.quality.averageLatencyMs, 100);
    assert.equal(dashboard.quality.p95LatencyMs, 100);
    assert.equal(dashboard.quality.toolParameterSamples, 1);
    assert.equal(dashboard.quality.actionExecutionSamples, 1, 'a replayed confirmation counts once');
    assert.equal(dashboard.quality.actionExecutionSuccessRate, 1);
  } finally {
    database.raw.close();
  }
});
