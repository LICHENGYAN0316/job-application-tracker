import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentAdminForbiddenError,
  AgentAdminInvalidLimitError,
  AgentAdminProtectedAccountError,
  AgentAdminTargetNotFoundError,
  isAgentDailyLimit,
  readAgentAdminDashboard,
  requireAgentAdmin,
  setAgentDefaultLimit,
  setAgentGlobalEnabled,
  setAgentUserDisabled,
  setAgentUserLimit,
} from './agent-admin.server.ts';
import type { AgentDatabase, AgentRuntimeConfig } from './agent-service.server.ts';
import type { AuthPrincipal } from './auth-principal.server.ts';

type QueryRecord = {
  query: string;
  values: unknown[];
  method: 'all' | 'first' | 'run';
};

type FakeResults = {
  setting?: Record<string, unknown> | null;
  users?: Array<Record<string, unknown>>;
  totals?: Record<string, unknown> | null;
  quality?: Record<string, unknown> | null;
  target?: Record<string, unknown> | null;
};

class FakeStatement {
  private values: unknown[] = [];
  private readonly query: string;
  private readonly database: FakeAdminDatabase;

  constructor(query: string, database: FakeAdminDatabase) {
    this.query = query;
    this.database = database;
  }

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>() {
    this.database.records.push({ query: this.query, values: this.values, method: 'first' });
    if (/SELECT\s+global_enabled,\s*default_daily_limit\s+FROM\s+agent_settings/i.test(this.query)) {
      return (this.database.results.setting ?? null) as T | null;
    }
    if (/FROM\s+agent_calls\s*$/i.test(this.query.trim())) {
      return (this.database.results.quality ?? null) as T | null;
    }
    if (/FROM\s+agent_calls\s+WHERE\s+status\s*=\s*'success'/i.test(this.query)) {
      return (this.database.results.totals ?? null) as T | null;
    }
    if (/SELECT\s+role\s+FROM\s+agent_users\s+WHERE\s+id\s*=\s*\?/i.test(this.query)) {
      return (this.database.results.target ?? null) as T | null;
    }
    throw new Error(`Unexpected first() query: ${this.query}`);
  }

  async all<T>() {
    this.database.records.push({ query: this.query, values: this.values, method: 'all' });
    if (/FROM\s+agent_users\s+u/i.test(this.query)) {
      return { results: (this.database.results.users ?? []) as T[] };
    }
    throw new Error(`Unexpected all() query: ${this.query}`);
  }

  async run() {
    this.database.records.push({ query: this.query, values: this.values, method: 'run' });
    if (/UPDATE\s+agent_settings/i.test(this.query) || /UPDATE\s+agent_users/i.test(this.query)) {
      return { meta: { changes: 1 } };
    }
    throw new Error(`Unexpected run() query: ${this.query}`);
  }
}

class FakeAdminDatabase {
  readonly records: QueryRecord[] = [];
  readonly results: FakeResults;

  constructor(results: FakeResults = {}) {
    this.results = results;
  }

  prepare(query: string) {
    return new FakeStatement(query, this) as unknown as ReturnType<AgentDatabase['prepare']>;
  }
}

const ADMIN: AuthPrincipal = {
  id: 'chatgpt-owner-stable-id',
  email: 'owner@example.com',
  provider: 'chatgpt',
  subject: 'chatgpt-owner-stable-id',
  displayName: 'owner@example.com',
};

const ORDINARY_CHATGPT_USER: AuthPrincipal = {
  id: 'chatgpt-user-id',
  email: 'user@example.com',
  provider: 'chatgpt',
  subject: 'chatgpt-user-id',
  displayName: 'user@example.com',
};

const GITHUB_USER: AuthPrincipal = {
  id: 'github:123456',
  email: 'owner@example.com',
  provider: 'github',
  subject: '123456',
  displayName: 'github-user',
};

const CONFIG: AgentRuntimeConfig = {
  apiKey: 'server-only-test-key',
  model: 'test-model',
  adminChatgptUserId: ADMIN.subject,
};

const NOW_MS = 1_800_000_000_000;

test('only the exact configured ChatGPT principal can access Agent administration', async () => {
  assert.doesNotThrow(() => requireAgentAdmin(ADMIN, CONFIG));
  assert.throws(
    () => requireAgentAdmin(ORDINARY_CHATGPT_USER, CONFIG),
    AgentAdminForbiddenError,
  );
  assert.throws(
    () => requireAgentAdmin(GITHUB_USER, CONFIG),
    AgentAdminForbiddenError,
    'matching email never promotes a separate GitHub identity to administrator',
  );

  const ordinaryDatabase = new FakeAdminDatabase();
  await assert.rejects(
    readAgentAdminDashboard(ordinaryDatabase, ORDINARY_CHATGPT_USER, CONFIG, NOW_MS),
    AgentAdminForbiddenError,
  );
  assert.equal(ordinaryDatabase.records.length, 0, 'authorization happens before any database query');

  const githubDatabase = new FakeAdminDatabase();
  await assert.rejects(
    setAgentGlobalEnabled(githubDatabase, GITHUB_USER, CONFIG, true, NOW_MS),
    AgentAdminForbiddenError,
  );
  assert.equal(githubDatabase.records.length, 0);
});

test('dashboard exposes privacy-safe user summaries and computes evidence-backed evaluation metrics', async () => {
  const database = new FakeAdminDatabase({
    setting: { global_enabled: 1, default_daily_limit: 5 },
    users: [
      {
        user_number: 7,
        role: 'admin',
        disabled: 0,
        quota_override: null,
        used_24h: 8,
        last_call_at_ms: NOW_MS - 5_000,
        total_tokens: 2_000,
        estimated_cost_micro_cny: 900,
        account_key: 'must-not-leak',
        email: 'must-not-leak@example.com',
      },
      {
        user_number: 19,
        role: 'unexpected-role',
        disabled: 1,
        quota_override: 12,
        used_24h: 3.9,
        last_call_at_ms: 0,
        total_tokens: 400,
        estimated_cost_micro_cny: 120,
      },
    ],
    totals: {
      successful_calls: 15,
      total_tokens: 2_400,
      estimated_cost_micro_cny: 1_020,
    },
    quality: {
      successful_calls: 8,
      technical_failures: 2,
      latency_samples: 7,
      average_latency_ms: 1_250.5,
      p95_latency_ms: 1_800,
      successful_sessions: 6,
      rated_tasks: 5,
      completed_tasks: 4,
      one_round_resolved_tasks: 3,
      average_completed_rounds: 2.25,
      resolved_task_cost_total: 2_000,
      tool_parameter_samples: 10,
      valid_tool_parameters: 9,
      action_execution_samples: 4,
      executed_actions: 3,
      ambiguity_samples: 3,
      handled_ambiguities: 3,
      action_feedback_samples: 2,
      incorrect_actions: 1,
      unauthorized_executions: 0,
      duplicate_blocks: 2,
      version_conflicts: 1,
    },
  });

  const dashboard = await readAgentAdminDashboard(database, ADMIN, CONFIG, NOW_MS);

  assert.equal(dashboard.globalEnabled, true);
  assert.equal(dashboard.defaultLimit, 5);
  assert.deepEqual(dashboard.users, [
    {
      userNumber: 7,
      role: 'admin',
      disabled: false,
      limitOverride: null,
      effectiveLimit: null,
      used24h: 8,
      lastCallAt: new Date(NOW_MS - 5_000).toISOString(),
      totalTokens: 2_000,
    },
    {
      userNumber: 19,
      role: 'user',
      disabled: true,
      limitOverride: 12,
      effectiveLimit: 12,
      used24h: 3,
      lastCallAt: null,
      totalTokens: 400,
    },
  ]);
  assert.deepEqual(dashboard.totals, {
    successfulCalls: 15,
    totalTokens: 2_400,
  });
  assert.deepEqual(dashboard.quality, {
    technicalSuccessRate: 0.8,
    technicalSamples: 10,
    taskSuccessRate: 0.8,
    ratedTasks: 5,
    oneRoundResolutionRate: 0.6,
    oneRoundResolvedTasks: 3,
    feedbackCoverageRate: 5 / 6,
    feedbackEligibleTasks: 6,
    toolParameterSchemaPassRate: 0.9,
    toolParameterSamples: 10,
    actionExecutionSuccessRate: 0.75,
    actionExecutionSamples: 4,
    ambiguitySafeClarificationRate: 1,
    ambiguitySamples: 3,
    wrongActionRate: 0.5,
    actionFeedbackSamples: 2,
    unauthorizedExecutionCount: 0,
    duplicateBlockedCount: 2,
    versionConflictRate: 0.25,
    versionConflictSamples: 4,
    averageCompletedRounds: 2.25,
    completedTasks: 4,
    averageLatencyMs: 1_250.5,
    p95LatencyMs: 1_800,
    latencySamples: 7,
  });

  assert.equal('accountKey' in dashboard.users[0], false);
  assert.equal('email' in dashboard.users[0], false);
  assert.equal('estimatedCostMicroCny' in dashboard.users[0], false);
  assert.equal('estimatedCostMicroCny' in dashboard.totals, false);
  assert.doesNotMatch(JSON.stringify(dashboard), /must-not-leak/);
  const userQuery = database.records.find((record) => record.method === 'all');
  assert.deepEqual(userQuery?.values, [NOW_MS - 24 * 60 * 60 * 1_000]);
  assert.doesNotMatch(userQuery?.query ?? '', /estimated_cost_micro_cny/i);
  const qualityQuery = database.records.find((record) => (
    record.method === 'first' && /FROM\s+agent_calls\s*$/i.test(record.query.trim())
  ));
  assert.match(
    qualityQuery?.query ?? '',
    /COUNT\(DISTINCT proposal_id\)[\s\S]*event_type = 'execution_started'/i,
    'replayed confirmation clicks must not dilute the execution success rate',
  );
  assert.match(
    qualityQuery?.query ?? '',
    /agent_action_proposals[\s\S]*feedback = 'correct'/i,
    'confirmed action outcomes must participate in task-level evaluation',
  );
  assert.match(
    qualityQuery?.query ?? '',
    /status = 'success' AND latency_ms > 0/i,
    'legacy zero-latency rows must not be presented as measured response times',
  );
});

test('dashboard reports empty and unavailable quality samples honestly instead of zero percent', async () => {
  const database = new FakeAdminDatabase({
    setting: { global_enabled: 0, default_daily_limit: 9 },
    users: [],
    totals: null,
    quality: {
      successful_calls: 0,
      technical_failures: 0,
      latency_samples: 0,
      average_latency_ms: 0,
      p95_latency_ms: null,
      successful_sessions: 0,
      rated_tasks: 0,
      completed_tasks: 0,
      one_round_resolved_tasks: 0,
      average_completed_rounds: 0,
      resolved_task_cost_total: 0,
      tool_parameter_samples: 0,
      valid_tool_parameters: 0,
      action_execution_samples: 0,
      executed_actions: 0,
      ambiguity_samples: 0,
      handled_ambiguities: 0,
      action_feedback_samples: 0,
      incorrect_actions: 0,
      unauthorized_executions: 0,
      duplicate_blocks: 0,
      version_conflicts: 0,
    },
  });

  const dashboard = await readAgentAdminDashboard(database, ADMIN, CONFIG, NOW_MS);

  assert.equal(dashboard.globalEnabled, false);
  assert.equal(dashboard.defaultLimit, 9);
  assert.deepEqual(dashboard.totals, {
    successfulCalls: 0,
    totalTokens: 0,
  });
  assert.deepEqual(dashboard.quality, {
    technicalSuccessRate: null,
    technicalSamples: 0,
    taskSuccessRate: null,
    ratedTasks: 0,
    oneRoundResolutionRate: null,
    oneRoundResolvedTasks: 0,
    feedbackCoverageRate: null,
    feedbackEligibleTasks: 0,
    toolParameterSchemaPassRate: null,
    toolParameterSamples: 0,
    actionExecutionSuccessRate: null,
    actionExecutionSamples: 0,
    ambiguitySafeClarificationRate: null,
    ambiguitySamples: 0,
    wrongActionRate: null,
    actionFeedbackSamples: 0,
    unauthorizedExecutionCount: 0,
    duplicateBlockedCount: 0,
    versionConflictRate: null,
    versionConflictSamples: 0,
    averageCompletedRounds: null,
    completedTasks: 0,
    averageLatencyMs: null,
    p95LatencyMs: null,
    latencySamples: 0,
  });
});

test('administrator can turn the global model switch on or off with an audited identity', async () => {
  for (const enabled of [true, false]) {
    const database = new FakeAdminDatabase();
    await setAgentGlobalEnabled(database, ADMIN, CONFIG, enabled, NOW_MS);
    const update = database.records.find((record) => record.method === 'run');
    assert.match(update?.query ?? '', /UPDATE\s+agent_settings/i);
    assert.deepEqual(update?.values, [enabled ? 1 : 0, NOW_MS, ADMIN.id]);
  }
});

test('administrator can change the default 24-hour limit within the safe integer range', async () => {
  assert.equal(isAgentDailyLimit(0), true);
  assert.equal(isAgentDailyLimit(100), true);
  assert.equal(isAgentDailyLimit(-1), false);
  assert.equal(isAgentDailyLimit(101), false);
  assert.equal(isAgentDailyLimit(1.5), false);

  const database = new FakeAdminDatabase();
  await setAgentDefaultLimit(database, ADMIN, CONFIG, 20, NOW_MS);
  const update = database.records.find((record) => record.method === 'run');
  assert.match(update?.query ?? '', /default_daily_limit/i);
  assert.deepEqual(update?.values, [20, NOW_MS, ADMIN.id]);

  for (const invalid of [-1, 101, 1.5, Number.NaN]) {
    const invalidDatabase = new FakeAdminDatabase();
    await assert.rejects(
      setAgentDefaultLimit(invalidDatabase, ADMIN, CONFIG, invalid, NOW_MS),
      AgentAdminInvalidLimitError,
    );
    assert.equal(invalidDatabase.records.length, 0);
  }
});

test('administrator can disable and re-enable an ordinary user by privacy-safe user number', async () => {
  for (const disabled of [true, false]) {
    const database = new FakeAdminDatabase({ target: { role: 'user' } });
    await setAgentUserDisabled(database, ADMIN, CONFIG, 42, disabled);
    const lookup = database.records.find((record) => record.method === 'first');
    const update = database.records.find((record) => record.method === 'run');
    assert.deepEqual(lookup?.values, [42]);
    assert.match(update?.query ?? '', /UPDATE\s+agent_users/i);
    assert.deepEqual(update?.values, [disabled ? 1 : 0, 42]);
  }
});

test('administrator can override or restore an ordinary user limit', async () => {
  for (const limit of [0, 37, 100, null] as const) {
    const database = new FakeAdminDatabase({ target: { role: 'user' } });
    await setAgentUserLimit(database, ADMIN, CONFIG, 42, limit);
    const lookup = database.records.find((record) => record.method === 'first');
    const update = database.records.find((record) => record.method === 'run');
    assert.deepEqual(lookup?.values, [42]);
    assert.match(update?.query ?? '', /quota_override/i);
    assert.deepEqual(update?.values, [limit, 42]);
  }
});

test('invalid per-user limits and administrator overrides are rejected before updating', async () => {
  const invalidDatabase = new FakeAdminDatabase({ target: { role: 'user' } });
  await assert.rejects(
    setAgentUserLimit(invalidDatabase, ADMIN, CONFIG, 42, 101),
    AgentAdminInvalidLimitError,
  );
  assert.equal(invalidDatabase.records.length, 0);

  const protectedDatabase = new FakeAdminDatabase({ target: { role: 'admin' } });
  await assert.rejects(
    setAgentUserLimit(protectedDatabase, ADMIN, CONFIG, 7, 30),
    AgentAdminProtectedAccountError,
  );
  assert.equal(protectedDatabase.records.filter((record) => record.method === 'run').length, 0);
});

test('administrator account is protected from per-user disabling', async () => {
  const database = new FakeAdminDatabase({ target: { role: 'admin' } });

  await assert.rejects(
    setAgentUserDisabled(database, ADMIN, CONFIG, 7, true),
    AgentAdminProtectedAccountError,
  );
  assert.equal(database.records.filter((record) => record.method === 'run').length, 0);
});

test('missing user number returns a target-not-found error without updating another account', async () => {
  const database = new FakeAdminDatabase({ target: null });

  await assert.rejects(
    setAgentUserDisabled(database, ADMIN, CONFIG, 999, true),
    AgentAdminTargetNotFoundError,
  );
  assert.equal(database.records.filter((record) => record.method === 'run').length, 0);
});
