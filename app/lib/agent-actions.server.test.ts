import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  AGENT_ACTION_PROPOSAL_TTL_MS,
  cancelAgentAction,
  confirmAgentAction,
  createAgentActionProposal,
  ensureAgentActionSchema,
  parseAgentActionToolCall,
  prepareAgentActionFromToolCall,
  recordAgentActionFeedback,
  type AgentActionDatabase,
  type AgentActionStatement,
} from './agent-actions.server.ts';
import type { AuthPrincipal } from './auth-principal.server.ts';

class SqliteStatement implements AgentActionStatement {
  readonly owner: TestDatabase;
  readonly query: string;
  readonly values: unknown[];

  constructor(owner: TestDatabase, query: string, values: unknown[] = []) {
    this.owner = owner;
    this.query = query;
    this.values = values;
  }

  bind(...values: unknown[]) {
    return new SqliteStatement(this.owner, this.query, values);
  }

  async first<T>() {
    const row = this.owner.sqlite.prepare(this.query).get(...this.values as never[]);
    return (row ?? null) as T | null;
  }

  runSync() {
    const result = this.owner.sqlite.prepare(this.query).run(...this.values as never[]);
    return { meta: { changes: Number(result.changes) } };
  }

  async run() {
    return this.runSync();
  }
}

class TestDatabase implements AgentActionDatabase {
  readonly sqlite = new DatabaseSync(':memory:');

  prepare(query: string) {
    return new SqliteStatement(this, query);
  }

  async batch(statements: AgentActionStatement[]) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => (statement as SqliteStatement).runSync());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.sqlite.close();
  }
}

const USER_A: AuthPrincipal = {
  id: 'chatgpt-user-a',
  email: 'a@example.com',
  provider: 'chatgpt',
  subject: 'chatgpt-user-a',
  displayName: 'A',
};

const USER_B: AuthPrincipal = {
  id: 'github:20260901',
  email: '',
  provider: 'github',
  subject: '20260901',
  displayName: 'B',
};

const NOW = Date.UTC(2026, 8, 1, 3, 0, 0);

function makeJob(id: string, title: string, location: string) {
  return {
    id,
    title,
    location,
    jobType: '校招',
    portalUrl: '',
    appliedAt: '',
    stage: '意向岗位',
    priority: '中',
    nextAction: '',
    nextDate: '',
    notes: 'private note that must never enter action telemetry',
    process: [],
  };
}

function makeCompany(id: string, name: string, jobs = [makeJob(`${id}-job`, '产品经理', '上海')]) {
  return {
    id,
    name,
    shortName: name.slice(0, 2),
    website: `https://example.com/${id}`,
    color: '#275A53',
    note: 'company private note',
    jobs,
  };
}

function baseState() {
  return { companies: [makeCompany('company-a', '星河能源')] };
}

async function emptyDatabase() {
  const database = new TestDatabase();
  database.sqlite.exec(`
    CREATE TABLE application_states (
      user_id TEXT PRIMARY KEY,
      user_email TEXT NOT NULL DEFAULT '',
      data_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT '',
      deleted_at TEXT
    ) WITHOUT ROWID
  `);
  await ensureAgentActionSchema(database);
  return database;
}

async function databaseWithState(state: unknown = baseState(), version = 'version-1') {
  const database = await emptyDatabase();
  database.sqlite.prepare(`
    INSERT INTO application_states (user_id, user_email, data_json, updated_at, version, deleted_at)
    VALUES (?, ?, ?, ?, ?, NULL)
  `).run(USER_A.id, USER_A.email, JSON.stringify(state), new Date(NOW).toISOString(), version);
  return database;
}

async function propose(
  database: TestDatabase,
  toolCall: unknown,
  principal = USER_A,
  now = NOW,
) {
  return createAgentActionProposal({
    database,
    principal,
    sessionId: crypto.randomUUID(),
    sourceCallId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    confirmationNonce: crypto.randomUUID(),
    toolCall,
    dependencies: { now: () => now },
  });
}

function stateFor(database: TestDatabase, userId = USER_A.id) {
  const row = database.sqlite.prepare(
    'SELECT data_json, version FROM application_states WHERE user_id = ?',
  ).get(userId) as { data_json: string; version: string } | undefined;
  return row ? { state: JSON.parse(row.data_json) as ReturnType<typeof baseState>, version: row.version } : null;
}

test('strictly validates create, update, and delete proposal tool shapes', () => {
  const valid = [
    { kind: 'add_company', companyName: '新能源科技', website: 'https://example.com/careers' },
    {
      kind: 'add_job', companyName: '星河能源', title: '算法工程师',
      location: '北京', portalUrl: '', appliedAt: '2026-09-01',
    },
    { kind: 'update_company', companyName: '星河能源', newName: '星河新能源', website: null },
    {
      kind: 'update_job', companyName: '星河能源', title: '产品经理', location: '上海',
      newTitle: null, newLocation: null, portalUrl: null, appliedAt: null,
      stage: '一面', priority: null, nextAction: null, nextDate: null,
    },
    { kind: 'delete_company', companyName: '星河能源' },
    { kind: 'delete_job', companyName: '星河能源', title: '产品经理', location: '上海' },
  ];
  for (const action of valid) assert.equal(parseAgentActionToolCall(action).ok, true);
  assert.equal(parseAgentActionToolCall({ ...valid[0], unexpected: true }).ok, false);
  assert.equal(parseAgentActionToolCall({ ...valid[1], appliedAt: '2026-02-30' }).ok, false);
  assert.equal(parseAgentActionToolCall({ ...valid[3], stage: '三面' }).ok, false);
  assert.equal(parseAgentActionToolCall({ kind: 'delete_everything' }).ok, false);
});

test('prepares a model tool call as a non-executing proposal with the public UI contract', async (t) => {
  const database = await databaseWithState();
  t.after(() => database.close());
  const sourceCallId = crypto.randomUUID();
  const result = await prepareAgentActionFromToolCall({
    database,
    principal: USER_A,
    sourceCallId,
    sessionId: crypto.randomUUID(),
    toolName: 'propose_delete_job',
    argumentsJson: JSON.stringify({ companyName: '星河能源', title: '产品经理', location: '上海' }),
    now: () => NOW,
  });
  assert.equal(result.kind, 'proposal');
  if (result.kind !== 'proposal') return;
  assert.equal(result.proposal.actionKind, 'delete_job');
  assert.equal(result.proposal.destructive, true);
  assert.match(result.proposal.impact, /删除 1 个岗位/);
  assert.equal(result.proposal.details[0].value, '星河能源');
  assert.equal(stateFor(database)?.state.companies[0].jobs.length, 1);
});

test('unknown tools and malformed argument JSON enter the anonymous schema-validation denominator', async (t) => {
  const database = await databaseWithState();
  t.after(() => database.close());
  const sessionId = crypto.randomUUID();
  const unknown = await prepareAgentActionFromToolCall({
    database, principal: USER_A, sourceCallId: 'provider-call-unknown', sessionId,
    toolName: 'delete_everything', argumentsJson: '{}', now: () => NOW,
  });
  const malformed = await prepareAgentActionFromToolCall({
    database, principal: USER_A, sourceCallId: 'provider-call-malformed', sessionId,
    toolName: 'propose_add_job', argumentsJson: '{not-json', now: () => NOW,
  });
  assert.equal(unknown.kind, 'clarification');
  assert.equal(malformed.kind, 'clarification');
  const invalid = database.sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM agent_action_events
    WHERE event_type = 'proposal_rejected' AND schema_valid = 0
  `).get() as { count: number };
  assert.equal(Number(invalid.count), 2);
});

test('adds a company only after confirmation and replays idempotently', async (t) => {
  const database = await databaseWithState();
  t.after(() => database.close());
  const proposal = await propose(database, {
    kind: 'add_company', companyName: '远山智造', website: 'https://example.com/yuanshan',
  });
  assert.equal(proposal.ok, true);
  if (!proposal.ok) return;
  assert.equal(stateFor(database)?.state.companies.length, 1);
  const requestId = crypto.randomUUID();
  const confirmed = await confirmAgentAction({
    database,
    principal: USER_A,
    actionId: proposal.proposal.id,
    confirmationNonce: proposal.proposal.confirmationNonce,
    requestId,
    dependencies: { now: () => NOW + 1_000 },
  });
  assert.equal(confirmed.ok, true);
  if (!confirmed.ok) return;
  const added = confirmed.state as ReturnType<typeof baseState>;
  assert.equal(added.companies.length, 2);
  assert.deepEqual(added.companies[1], {
    id: added.companies[1].id,
    name: '远山智造',
    shortName: '远山',
    website: 'https://example.com/yuanshan',
    color: '#275A53',
    note: '',
    jobs: [],
  });
  const replay = await confirmAgentAction({
    database,
    principal: USER_A,
    actionId: proposal.proposal.id,
    confirmationNonce: proposal.proposal.confirmationNonce,
    requestId,
    dependencies: { now: () => NOW + 2_000 },
  });
  assert.equal(replay.ok, true);
  if (replay.ok) assert.equal(replay.replayed, true);
  assert.equal(stateFor(database)?.state.companies.length, 2);
  const executed = database.sqlite.prepare(
    "SELECT COUNT(*) AS count FROM agent_action_events WHERE event_type = 'executed'",
  ).get() as { count: number };
  assert.equal(Number(executed.count), 1);
  const parameterSamples = database.sqlite.prepare(
    'SELECT COUNT(*) AS count FROM agent_action_events WHERE schema_valid IS NOT NULL',
  ).get() as { count: number };
  assert.equal(Number(parameterSamples.count), 1);
  const terminalProposal = database.sqlite.prepare(
    'SELECT payload_json FROM agent_action_proposals WHERE id = ?',
  ).get(proposal.proposal.id) as { payload_json: string };
  assert.equal(terminalProposal.payload_json, '{}');
  const telemetry = JSON.stringify(database.sqlite.prepare('SELECT * FROM agent_action_events').all());
  assert.equal(telemetry.includes('private note'), false);
  assert.equal(telemetry.includes('远山智造'), false);
});

test('adds a company with an unfilled website only after confirmation', async (t) => {
  const database = await databaseWithState();
  t.after(() => database.close());
  const proposal = await propose(database, {
    kind: 'add_company', companyName: '无网站公司', website: '',
  });
  assert.equal(proposal.ok, true);
  if (!proposal.ok) return;
  assert.equal(proposal.proposal.details[1].value, '未填写');
  assert.equal(stateFor(database)?.state.companies.length, 1);
  const confirmed = await confirmAgentAction({
    database,
    principal: USER_A,
    actionId: proposal.proposal.id,
    confirmationNonce: proposal.proposal.confirmationNonce,
    requestId: crypto.randomUUID(),
    dependencies: { now: () => NOW + 1_000 },
  });
  assert.equal(confirmed.ok, true);
  if (!confirmed.ok) return;
  const added = confirmed.state as ReturnType<typeof baseState>;
  assert.equal(added.companies[1].website, '');
});

test('execution_started counts only a real leased write, not expiry or replay', async (t) => {
  const database = await databaseWithState();
  t.after(() => database.close());

  const expired = await propose(database, {
    kind: 'add_company', companyName: '过期不执行', website: 'https://example.com/expired-start',
  });
  assert.equal(expired.ok, true);
  if (!expired.ok) return;
  const expiredResult = await confirmAgentAction({
    database, principal: USER_A, actionId: expired.proposal.id,
    confirmationNonce: expired.proposal.confirmationNonce, requestId: crypto.randomUUID(),
    dependencies: { now: () => NOW + AGENT_ACTION_PROPOSAL_TTL_MS },
  });
  assert.equal(expiredResult.ok, false);
  if (!expiredResult.ok) assert.equal(expiredResult.code, 'expired');

  const live = await propose(database, {
    kind: 'add_company', companyName: '执行计数公司', website: 'https://example.com/execution-start',
  }, USER_A, NOW + 1);
  assert.equal(live.ok, true);
  if (!live.ok) return;
  const requestId = crypto.randomUUID();
  const first = await confirmAgentAction({
    database, principal: USER_A, actionId: live.proposal.id,
    confirmationNonce: live.proposal.confirmationNonce, requestId,
    dependencies: { now: () => NOW + 2 },
  });
  assert.equal(first.ok, true);
  const replay = await confirmAgentAction({
    database, principal: USER_A, actionId: live.proposal.id,
    confirmationNonce: live.proposal.confirmationNonce, requestId: crypto.randomUUID(),
    dependencies: { now: () => NOW + 3 },
  });
  assert.equal(replay.ok, true);
  if (replay.ok) assert.equal(replay.replayed, true);

  const allStarts = database.sqlite.prepare(`
    SELECT proposal_id, COUNT(*) AS count
    FROM agent_action_events
    WHERE event_type = 'execution_started'
    GROUP BY proposal_id
  `).all() as Array<{ proposal_id: string; count: number }>;
  assert.equal(allStarts.length, 1);
  assert.equal(allStarts[0].proposal_id, live.proposal.id);
  assert.equal(Number(allStarts[0].count), 1);
});

test('creates the first state row when a new account confirms its first company', async (t) => {
  const database = await emptyDatabase();
  t.after(() => database.close());
  const proposal = await propose(database, {
    kind: 'add_company', companyName: '首家公司', website: 'https://example.com/first',
  });
  assert.equal(proposal.ok, true);
  if (!proposal.ok) return;
  const confirmed = await confirmAgentAction({
    database, principal: USER_A, actionId: proposal.proposal.id,
    confirmationNonce: proposal.proposal.confirmationNonce, requestId: crypto.randomUUID(),
    dependencies: { now: () => NOW + 1 },
  });
  assert.equal(confirmed.ok, true);
  assert.equal(stateFor(database)?.state.companies[0].name, '首家公司');
});

test('a historical empty state version is preserved for CAS and executes exactly once', async (t) => {
  const database = await databaseWithState(baseState(), '');
  t.after(() => database.close());
  const proposal = await propose(database, {
    kind: 'add_company', companyName: '历史版本公司', website: 'https://example.com/legacy',
  });
  assert.equal(proposal.ok, true);
  if (!proposal.ok) return;
  const requestId = crypto.randomUUID();
  const first = await confirmAgentAction({
    database, principal: USER_A, actionId: proposal.proposal.id,
    confirmationNonce: proposal.proposal.confirmationNonce, requestId,
    dependencies: { now: () => NOW + 1 },
  });
  assert.equal(first.ok, true);
  const replay = await confirmAgentAction({
    database, principal: USER_A, actionId: proposal.proposal.id,
    confirmationNonce: proposal.proposal.confirmationNonce, requestId,
    dependencies: { now: () => NOW + 2 },
  });
  assert.equal(replay.ok, true);
  const matching = stateFor(database)?.state.companies.filter((company) => company.name === '历史版本公司');
  assert.equal(matching?.length, 1);
  assert.notEqual(stateFor(database)?.version, '');
});

test('two confirmation clicks can produce only one state mutation', async (t) => {
  const database = await databaseWithState();
  t.after(() => database.close());
  const proposal = await propose(database, {
    kind: 'add_company', companyName: '并发测试公司', website: 'https://example.com/concurrent',
  });
  assert.equal(proposal.ok, true);
  if (!proposal.ok) return;
  const confirm = (requestId: string) => confirmAgentAction({
    database,
    principal: USER_A,
    actionId: proposal.proposal.id,
    confirmationNonce: proposal.proposal.confirmationNonce,
    requestId,
    dependencies: { now: () => NOW + 1_000 },
  });
  const results = await Promise.all([confirm(crypto.randomUUID()), confirm(crypto.randomUUID())]);
  assert.equal(results.some((result) => result.ok), true);
  const matching = stateFor(database)?.state.companies.filter((company) => company.name === '并发测试公司');
  assert.equal(matching?.length, 1);
  const executed = database.sqlite.prepare(
    "SELECT COUNT(*) AS count FROM agent_action_events WHERE event_type = 'executed'",
  ).get() as { count: number };
  assert.equal(Number(executed.count), 1);
});

test('adds a job with fixed defaults and blocks a later duplicate', async (t) => {
  const database = await databaseWithState();
  t.after(() => database.close());
  const toolCall = {
    kind: 'add_job', companyName: '星河能源', title: '储能算法工程师',
    location: '北京', portalUrl: 'https://example.com/jobs/1', appliedAt: '2026-09-01',
  };
  const proposal = await propose(database, toolCall);
  assert.equal(proposal.ok, true);
  if (!proposal.ok) return;
  const confirmed = await confirmAgentAction({
    database, principal: USER_A, actionId: proposal.proposal.id,
    confirmationNonce: proposal.proposal.confirmationNonce, requestId: crypto.randomUUID(),
    dependencies: { now: () => NOW + 1 },
  });
  assert.equal(confirmed.ok, true);
  if (!confirmed.ok) return;
  const company = (confirmed.state as ReturnType<typeof baseState>).companies[0];
  const job = company.jobs[1];
  assert.equal(job.title, '储能算法工程师');
  assert.equal(job.jobType, '校招');
  assert.equal(job.stage, '意向岗位');
  assert.equal(job.priority, '中');
  assert.deepEqual(job.process, []);
  const duplicate = await propose(database, toolCall, USER_A, NOW + 2);
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.code, 'duplicate');
});

test('existing-company add accepts blank optional fields and shows them as unfilled before confirmation', async (t) => {
  const database = await databaseWithState();
  t.after(() => database.close());
  const result = await prepareAgentActionFromToolCall({
    database, principal: USER_A, sourceCallId: crypto.randomUUID(), sessionId: crypto.randomUUID(),
    toolName: 'propose_add_job',
    argumentsJson: JSON.stringify({ companyName: '星河能源', title: 'AI 产品经理' }),
    now: () => NOW,
  });
  assert.equal(result.kind, 'proposal');
  if (result.kind !== 'proposal') return;
  assert.equal(result.proposal.actionKind, 'add_job');
  assert.deepEqual(result.proposal.fields.slice(2).map((field) => field.value), ['未填写', '未填写', '未填写']);
  assert.equal(stateFor(database)?.state.companies[0].jobs.length, 1);
});

test('requester-local relative dates override a stale model date for existing and missing companies', async (t) => {
  const database = await databaseWithState();
  t.after(() => database.close());
  const existing = await prepareAgentActionFromToolCall({
    database, principal: USER_A, sourceCallId: crypto.randomUUID(), sessionId: crypto.randomUUID(),
    toolName: 'propose_add_job',
    argumentsJson: JSON.stringify({
      companyName: '星河能源', title: 'AI 产品经理', location: '', portalUrl: '', appliedAt: '2024-05-20',
    }),
    question: '加一个星河能源的 AI 产品经理岗位，投递日期写今天',
    referenceDate: '2026-09-01',
    now: () => NOW,
  });
  assert.equal(existing.kind, 'proposal');
  if (existing.kind === 'proposal') {
    assert.equal(existing.proposal.fields.find((field) => field.label === '投递日期')?.value, '2026-09-01');
  }

  const missing = await prepareAgentActionFromToolCall({
    database, principal: USER_A, sourceCallId: crypto.randomUUID(), sessionId: crypto.randomUUID(),
    toolName: 'propose_add_job',
    argumentsJson: JSON.stringify({
      companyName: '京东', title: '产品经理', location: '', portalUrl: '', appliedAt: '2024-05-20',
    }),
    question: '加一个京东的产品经理岗位，投递日期写今天',
    referenceDate: '2026-09-01',
    now: () => NOW,
  });
  assert.equal(missing.kind, 'proposal');
  if (missing.kind === 'proposal') {
    assert.equal(missing.proposal.actionKind, 'add_company_job');
    assert.equal(missing.proposal.fields.find((field) => field.label === '投递日期')?.value, '2026-09-01');
  }
  assert.equal(stateFor(database)?.state.companies.length, 1);
  assert.equal(stateFor(database)?.state.companies[0].jobs.length, 1);
});

test('date normalization preserves explicit empty and ISO dates and rejects a missing local-date reference', async (t) => {
  const database = await databaseWithState();
  t.after(() => database.close());
  const empty = await prepareAgentActionFromToolCall({
    database, principal: USER_A, sourceCallId: crypto.randomUUID(), sessionId: crypto.randomUUID(),
    toolName: 'propose_add_job',
    argumentsJson: JSON.stringify({
      companyName: '星河能源', title: '交互产品经理', location: '', portalUrl: '', appliedAt: '2024-05-20',
    }),
    question: '今天想新增岗位，投递日期未填写',
    now: () => NOW,
  });
  assert.equal(empty.kind, 'proposal');
  if (empty.kind === 'proposal') {
    assert.equal(empty.proposal.fields.find((field) => field.label === '投递日期')?.value, '未填写');
  }

  const explicit = await prepareAgentActionFromToolCall({
    database, principal: USER_A, sourceCallId: crypto.randomUUID(), sessionId: crypto.randomUUID(),
    toolName: 'propose_add_job',
    argumentsJson: JSON.stringify({
      companyName: '星河能源', title: '数据产品经理', location: '', portalUrl: '', appliedAt: '2026-09-01',
    }),
    question: '加一个数据产品经理岗位，投递日期写 2024-05-20',
    now: () => NOW,
  });
  assert.equal(explicit.kind, 'proposal');
  if (explicit.kind === 'proposal') {
    assert.equal(explicit.proposal.fields.find((field) => field.label === '投递日期')?.value, '2024-05-20');
  }

  const invalidReference = await prepareAgentActionFromToolCall({
    database, principal: USER_A, sourceCallId: crypto.randomUUID(), sessionId: crypto.randomUUID(),
    toolName: 'propose_add_job',
    argumentsJson: JSON.stringify({
      companyName: '星河能源', title: '增长产品经理', location: '', portalUrl: '', appliedAt: '2024-05-20',
    }),
    question: '加一个增长产品经理岗位，投递日期写今天',
    referenceDate: '',
    now: () => NOW,
  });
  assert.equal(invalidReference.kind, 'clarification');
  if (invalidReference.kind === 'clarification') assert.match(invalidReference.message, /当地的日期/);
});

test('unrequested dates are cleared from add tools and preserved by update tools', async (t) => {
  const database = await databaseWithState();
  t.after(() => database.close());
  const added = await prepareAgentActionFromToolCall({
    database, principal: USER_A, sourceCallId: crypto.randomUUID(), sessionId: crypto.randomUUID(),
    toolName: 'propose_add_job',
    argumentsJson: JSON.stringify({
      companyName: '星河能源', title: '平台产品经理', location: '', portalUrl: '', appliedAt: '2024-05-20',
    }),
    question: '加一个平台产品经理岗位',
    referenceDate: '2026-09-01',
    now: () => NOW,
  });
  assert.equal(added.kind, 'proposal');
  if (added.kind === 'proposal') {
    assert.equal(added.proposal.fields.find((field) => field.label === '投递日期')?.value, '未填写');
  }

  const updated = await prepareAgentActionFromToolCall({
    database, principal: USER_A, sourceCallId: crypto.randomUUID(), sessionId: crypto.randomUUID(),
    toolName: 'propose_update_job',
    argumentsJson: JSON.stringify({
      companyName: '星河能源', title: '产品经理', location: '上海',
      newTitle: null, newLocation: null, portalUrl: null, appliedAt: '2024-05-20',
      stage: '一面', priority: null, nextAction: null, nextDate: '2024-05-21',
    }),
    question: '把星河能源的产品经理岗位推进到一面',
    referenceDate: '2026-09-01',
    now: () => NOW,
  });
  assert.equal(updated.kind, 'proposal');
  if (updated.kind === 'proposal') {
    assert.equal(updated.proposal.fields.some((field) => /日期/.test(field.label)), false);
  }
});

test('missing-company add becomes one confirmed company-and-job proposal without pre-confirmation writes', async (t) => {
  const database = await databaseWithState();
  t.after(() => database.close());
  const proposal = await propose(database, {
    kind: 'add_job', companyName: '京东', title: 'AI产品经理', location: '', portalUrl: '', appliedAt: '',
  });
  assert.equal(proposal.ok, true);
  if (!proposal.ok) return;
  assert.equal(proposal.proposal.actionKind, 'add_company_job');
  assert.match(proposal.proposal.summary, /尚未找到“京东”/);
  assert.equal(stateFor(database)?.state.companies.length, 1);
  const confirmed = await confirmAgentAction({
    database, principal: USER_A, actionId: proposal.proposal.id,
    confirmationNonce: proposal.proposal.confirmationNonce, requestId: crypto.randomUUID(),
    dependencies: { now: () => NOW + 1 },
  });
  assert.equal(confirmed.ok, true);
  if (!confirmed.ok) return;
  const company = (confirmed.state as ReturnType<typeof baseState>).companies[1];
  assert.equal(company.name, '京东');
  assert.equal(company.website, '');
  assert.equal(company.jobs[0].title, 'AI产品经理');
  assert.equal(company.jobs[0].location, '');
});

test('company and job updates remain proposals until confirmation and preserve untouched fields', async (t) => {
  const database = await databaseWithState();
  t.after(() => database.close());
  const companyProposal = await propose(database, {
    kind: 'update_company', companyName: '星河能源', newName: '星河新能源', website: null,
  });
  assert.equal(companyProposal.ok, true);
  if (!companyProposal.ok) return;
  assert.equal(stateFor(database)?.state.companies[0].name, '星河能源');
  const companyConfirmed = await confirmAgentAction({
    database, principal: USER_A, actionId: companyProposal.proposal.id,
    confirmationNonce: companyProposal.proposal.confirmationNonce, requestId: crypto.randomUUID(),
    dependencies: { now: () => NOW + 1 },
  });
  assert.equal(companyConfirmed.ok, true);
  if (!companyConfirmed.ok) return;
  const company = (companyConfirmed.state as ReturnType<typeof baseState>).companies[0];
  assert.equal(company.name, '星河新能源');
  assert.equal(company.website, 'https://example.com/company-a');

  const jobProposal = await propose(database, {
    kind: 'update_job', companyName: '星河新能源', title: '产品经理', location: '上海',
    newTitle: null, newLocation: '', portalUrl: null, appliedAt: null,
    stage: '一面', priority: '高', nextAction: null, nextDate: null,
  }, USER_A, NOW + 2);
  assert.equal(jobProposal.ok, true);
  if (!jobProposal.ok) return;
  const jobConfirmed = await confirmAgentAction({
    database, principal: USER_A, actionId: jobProposal.proposal.id,
    confirmationNonce: jobProposal.proposal.confirmationNonce, requestId: crypto.randomUUID(),
    dependencies: { now: () => NOW + 3 },
  });
  assert.equal(jobConfirmed.ok, true);
  if (!jobConfirmed.ok) return;
  const job = (jobConfirmed.state as ReturnType<typeof baseState>).companies[0].jobs[0];
  assert.equal(job.stage, '一面');
  assert.equal(job.priority, '高');
  assert.equal(job.location, '');
  assert.equal(job.notes, 'private note that must never enter action telemetry');
});

test('query tool reads only the authenticated account and never creates a proposal or mutation', async (t) => {
  const database = await databaseWithState();
  t.after(() => database.close());
  const before = JSON.stringify(stateFor(database)?.state);
  const result = await prepareAgentActionFromToolCall({
    database, principal: USER_A, sourceCallId: crypto.randomUUID(), sessionId: crypto.randomUUID(),
    toolName: 'query_applications',
    argumentsJson: JSON.stringify({ companyName: '星河', title: '产品', location: '', stage: '' }),
    now: () => NOW,
  });
  assert.equal(result.kind, 'read');
  if (result.kind !== 'read') return;
  assert.match(result.message, /星河能源 · 产品经理/);
  assert.equal(JSON.stringify(stateFor(database)?.state), before);
  const proposals = database.sqlite.prepare('SELECT COUNT(*) AS count FROM agent_action_proposals').get() as { count: number };
  assert.equal(Number(proposals.count), 0);
  const telemetry = JSON.stringify(database.sqlite.prepare('SELECT * FROM agent_action_events').all());
  assert.equal(telemetry.includes('星河能源'), false);
});

test('deletes a company and its jobs only after valid confirmation', async (t) => {
  const database = await databaseWithState();
  t.after(() => database.close());
  const proposal = await propose(database, { kind: 'delete_company', companyName: '星河能源' });
  assert.equal(proposal.ok, true);
  if (!proposal.ok) return;
  assert.match(proposal.proposal.impact, /1 个岗位/);
  const confirmed = await confirmAgentAction({
    database, principal: USER_A, actionId: proposal.proposal.id,
    confirmationNonce: proposal.proposal.confirmationNonce, requestId: crypto.randomUUID(),
    dependencies: { now: () => NOW + 10 },
  });
  assert.equal(confirmed.ok, true);
  if (confirmed.ok) assert.equal((confirmed.state as ReturnType<typeof baseState>).companies.length, 0);
});

test('deletes exactly one uniquely matched job', async (t) => {
  const state = baseState();
  state.companies[0].jobs.push(makeJob('job-2', '后端工程师', '深圳'));
  const database = await databaseWithState(state);
  t.after(() => database.close());
  const proposal = await propose(database, {
    kind: 'delete_job', companyName: '星河能源', title: '产品经理', location: '上海',
  });
  assert.equal(proposal.ok, true);
  if (!proposal.ok) return;
  const confirmed = await confirmAgentAction({
    database, principal: USER_A, actionId: proposal.proposal.id,
    confirmationNonce: proposal.proposal.confirmationNonce, requestId: crypto.randomUUID(),
    dependencies: { now: () => NOW + 10 },
  });
  assert.equal(confirmed.ok, true);
  if (!confirmed.ok) return;
  const jobs = (confirmed.state as typeof state).companies[0].jobs;
  assert.deepEqual(jobs.map((job) => job.id), ['job-2']);
});

test('creates a safe combined proposal for a missing company but still clarifies multiple exact matches', async (t) => {
  const duplicatedCompanies = {
    companies: [
      makeCompany('company-1', '同名公司'),
      makeCompany('company-2', '同名公司'),
    ],
  };
  const database = await databaseWithState(duplicatedCompanies);
  t.after(() => database.close());
  const missing = await propose(database, {
    kind: 'add_job', companyName: '不存在的公司', title: '工程师', location: '', portalUrl: '', appliedAt: '',
  });
  assert.equal(missing.ok, true);
  if (missing.ok) assert.equal(missing.proposal.actionKind, 'add_company_job');
  const ambiguous = await propose(database, {
    kind: 'delete_company', companyName: '同名公司',
  });
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) {
    assert.equal(ambiguous.code, 'ambiguous');
    assert.equal(ambiguous.candidates?.length, 2);
  }
  assert.equal(stateFor(database)?.state.companies.length, 2);
  const safelyHandled = database.sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM agent_action_events
    WHERE event_type = 'clarification_required'
      AND ambiguity_detected = 1 AND ambiguity_handled = 1
  `).get() as { count: number };
  assert.equal(Number(safelyHandled.count), 1);
});

test('requires a location when duplicate job titles are ambiguous', async (t) => {
  const state = {
    companies: [makeCompany('company-a', '星河能源', [
      makeJob('job-sh', '产品经理', '上海'),
      makeJob('job-bj', '产品经理', '北京'),
    ])],
  };
  const database = await databaseWithState(state);
  t.after(() => database.close());
  const ambiguous = await propose(database, {
    kind: 'delete_job', companyName: '星河能源', title: '产品经理', location: '',
  });
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) assert.equal(ambiguous.code, 'ambiguous');
  const exact = await propose(database, {
    kind: 'delete_job', companyName: '星河能源', title: '产品经理', location: '北京',
  });
  assert.equal(exact.ok, true);
});

test('isolates proposals by account and rejects a wrong confirmation nonce', async (t) => {
  const database = await databaseWithState();
  t.after(() => database.close());
  const proposal = await propose(database, { kind: 'delete_company', companyName: '星河能源' });
  assert.equal(proposal.ok, true);
  if (!proposal.ok) return;
  const crossUser = await confirmAgentAction({
    database, principal: USER_B, actionId: proposal.proposal.id,
    confirmationNonce: proposal.proposal.confirmationNonce, requestId: crypto.randomUUID(),
    dependencies: { now: () => NOW + 1 },
  });
  assert.equal(crossUser.ok, false);
  if (!crossUser.ok) assert.equal(crossUser.code, 'not_found');
  const wrongNonce = await confirmAgentAction({
    database, principal: USER_A, actionId: proposal.proposal.id,
    confirmationNonce: crypto.randomUUID(), requestId: crypto.randomUUID(),
    dependencies: { now: () => NOW + 1 },
  });
  assert.equal(wrongNonce.ok, false);
  if (!wrongNonce.ok) assert.equal(wrongNonce.code, 'invalid_confirmation');
  assert.equal(stateFor(database)?.state.companies.length, 1);
});

test('expires proposals after ten minutes without mutating state', async (t) => {
  const database = await databaseWithState();
  t.after(() => database.close());
  const proposal = await propose(database, { kind: 'delete_company', companyName: '星河能源' });
  assert.equal(proposal.ok, true);
  if (!proposal.ok) return;
  const result = await confirmAgentAction({
    database, principal: USER_A, actionId: proposal.proposal.id,
    confirmationNonce: proposal.proposal.confirmationNonce, requestId: crypto.randomUUID(),
    dependencies: { now: () => NOW + (10 * 60 * 1_000) },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'expired');
  assert.equal(stateFor(database)?.state.companies.length, 1);
});

test('later account activity expires abandoned proposals and clears only their minimal payload', async (t) => {
  const database = await databaseWithState();
  t.after(() => database.close());
  const abandoned = await propose(database, {
    kind: 'add_company', companyName: '过期公司', website: 'https://example.com/expired',
  }, USER_A, NOW);
  const otherAccount = await propose(database, {
    kind: 'add_company', companyName: '其他账号公司', website: 'https://example.com/other',
  }, USER_B, NOW);
  const active = await propose(database, {
    kind: 'add_company', companyName: '活跃公司', website: 'https://example.com/active',
  }, USER_A, NOW + AGENT_ACTION_PROPOSAL_TTL_MS - 1_000);
  assert.equal(abandoned.ok, true);
  assert.equal(otherAccount.ok, true);
  assert.equal(active.ok, true);
  if (!abandoned.ok || !otherAccount.ok || !active.ok) return;

  await recordAgentActionFeedback({
    database,
    principal: USER_A,
    actionId: crypto.randomUUID(),
    outcome: 'correct',
    now: () => NOW + AGENT_ACTION_PROPOSAL_TTL_MS,
  });

  const readProposal = (id: string) => database.sqlite.prepare(`
    SELECT status, completed_at_ms, failure_code, payload_json
    FROM agent_action_proposals WHERE id = ?
  `).get(id) as {
    status: string;
    completed_at_ms: number | null;
    failure_code: string;
    payload_json: string;
  };
  const expiredRow = readProposal(abandoned.proposal.id);
  assert.equal(expiredRow.status, 'expired');
  assert.equal(Number(expiredRow.completed_at_ms), NOW + AGENT_ACTION_PROPOSAL_TTL_MS);
  assert.equal(expiredRow.failure_code, 'proposal_expired');
  assert.equal(expiredRow.payload_json, '{}');

  const activeRow = readProposal(active.proposal.id);
  assert.equal(activeRow.status, 'awaiting_confirmation');
  assert.notEqual(activeRow.payload_json, '{}');

  const otherRow = readProposal(otherAccount.proposal.id);
  assert.equal(otherRow.status, 'awaiting_confirmation');
  assert.notEqual(otherRow.payload_json, '{}');
});

test('rejects a stale state version and records a conflict instead of executing', async (t) => {
  const database = await databaseWithState();
  t.after(() => database.close());
  const proposal = await propose(database, { kind: 'delete_company', companyName: '星河能源' });
  assert.equal(proposal.ok, true);
  if (!proposal.ok) return;
  database.sqlite.prepare('UPDATE application_states SET version = ? WHERE user_id = ?').run('version-2', USER_A.id);
  const result = await confirmAgentAction({
    database, principal: USER_A, actionId: proposal.proposal.id,
    confirmationNonce: proposal.proposal.confirmationNonce, requestId: crypto.randomUUID(),
    dependencies: { now: () => NOW + 1 },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'conflict');
  assert.equal(stateFor(database)?.state.companies.length, 1);
  const conflict = database.sqlite.prepare(
    "SELECT COUNT(*) AS count FROM agent_action_events WHERE event_type = 'execution_conflict'",
  ).get() as { count: number };
  assert.equal(Number(conflict.count), 1);
  const executed = database.sqlite.prepare(
    "SELECT COUNT(*) AS count FROM agent_action_events WHERE event_type = 'executed'",
  ).get() as { count: number };
  assert.equal(Number(executed.count), 0);
});

test('cancellation is idempotent and prevents later execution', async (t) => {
  const database = await databaseWithState();
  t.after(() => database.close());
  const proposal = await propose(database, { kind: 'delete_company', companyName: '星河能源' });
  assert.equal(proposal.ok, true);
  if (!proposal.ok) return;
  const first = await cancelAgentAction({
    database, principal: USER_A, actionId: proposal.proposal.id,
    confirmationNonce: proposal.proposal.confirmationNonce, dependencies: { now: () => NOW + 1 },
  });
  assert.equal(first.ok, true);
  const replay = await cancelAgentAction({
    database, principal: USER_A, actionId: proposal.proposal.id,
    confirmationNonce: proposal.proposal.confirmationNonce, dependencies: { now: () => NOW + 2 },
  });
  assert.equal(replay.ok, true);
  const confirm = await confirmAgentAction({
    database, principal: USER_A, actionId: proposal.proposal.id,
    confirmationNonce: proposal.proposal.confirmationNonce, requestId: crypto.randomUUID(),
    dependencies: { now: () => NOW + 3 },
  });
  assert.equal(confirm.ok, false);
  if (!confirm.ok) assert.equal(confirm.code, 'cancelled');
  assert.equal(stateFor(database)?.state.companies.length, 1);
});

test('stores one correct or incorrect review only for the executing account', async (t) => {
  const database = await databaseWithState();
  t.after(() => database.close());
  const proposal = await propose(database, {
    kind: 'add_company', companyName: '远山智造', website: 'https://example.com/yuanshan',
  });
  assert.equal(proposal.ok, true);
  if (!proposal.ok) return;
  const confirmed = await confirmAgentAction({
    database, principal: USER_A, actionId: proposal.proposal.id,
    confirmationNonce: proposal.proposal.confirmationNonce, requestId: crypto.randomUUID(),
    dependencies: { now: () => NOW + 1 },
  });
  assert.equal(confirmed.ok, true);
  assert.equal(await recordAgentActionFeedback({
    database, principal: USER_B, actionId: proposal.proposal.id, outcome: 'incorrect', now: () => NOW + 2,
  }), false);
  assert.equal(await recordAgentActionFeedback({
    database, principal: USER_A, actionId: proposal.proposal.id, outcome: 'correct', now: () => NOW + 2,
  }), true);
  assert.equal(await recordAgentActionFeedback({
    database, principal: USER_A, actionId: proposal.proposal.id, outcome: 'incorrect', now: () => NOW + 3,
  }), false);
  const row = database.sqlite.prepare(
    'SELECT feedback FROM agent_action_proposals WHERE id = ?',
  ).get(proposal.proposal.id) as { feedback: string };
  assert.equal(row.feedback, 'correct');
});
