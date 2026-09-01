import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthPrincipal } from './auth-principal.server.ts';
import {
  AGENT_DAILY_LIMIT,
  AGENT_MAX_QUESTION_LENGTH,
  AGENT_TECHNICAL_FAILURE_MESSAGE,
  AGENT_WINDOW_MS,
  getAgentUserStatus,
  isAgentAdmin,
  normalizeAgentQuestion,
  parseArkResponse,
  preferredAgentTool,
  recordAgentFeedback,
  runAgentQuery,
  type AgentDatabase,
  type AgentRuntimeConfig,
} from './agent-service.server.ts';

type AgentUserRow = {
  accountKey: string;
  authProvider: AuthPrincipal['provider'];
  role: 'admin' | 'user';
  disabled: boolean;
  quotaOverride: number | null;
  createdAtMs: number;
  lastSeenAtMs: number;
};

type AgentCallRow = {
  id: string;
  accountKey: string;
  authProvider: AuthPrincipal['provider'];
  isAdmin: boolean;
  idempotencyKey: string;
  sessionId: string;
  status: 'reserved' | 'success' | 'technical_failure';
  reservedAtMs: number;
  reservationExpiresAtMs: number;
  completedAtMs: number | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostMicroCny: number;
  latencyMs: number;
  feedback: 'resolved' | 'unresolved' | null;
  errorClass: string | null;
};

class FakeStatement {
  private values: unknown[] = [];
  private readonly query: string;
  private readonly database: FakeAgentDatabase;

  constructor(query: string, database: FakeAgentDatabase) {
    this.query = query;
    this.database = database;
  }

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>() {
    if (/SELECT\s+data_json\s+FROM\s+application_states/i.test(this.query)) {
      const dataJson = this.database.applicationStates.get(String(this.values[0]));
      return (dataJson === undefined ? null : { data_json: dataJson }) as T | null;
    }

    if (/AS\s+enabled/i.test(this.query) && /FROM\s+agent_calls/i.test(this.query)) {
      const accountKey = String(this.values[0]);
      const successCutoffMs = Number(this.values[2]);
      const reservationNowMs = Number(this.values[4]);
      const oldestCutoffMs = Number(this.values[6]);
      const user = this.database.users.get(accountKey);
      const successful = this.database.calls.filter((call) => (
        call.accountKey === accountKey
        && call.status === 'success'
        && (call.completedAtMs ?? 0) > successCutoffMs
      ));
      const oldestSuccesses = this.database.calls.filter((call) => (
        call.accountKey === accountKey
        && call.status === 'success'
        && (call.completedAtMs ?? 0) > oldestCutoffMs
      ));
      const oldestSuccess = oldestSuccesses.length > 0
        ? Math.min(...oldestSuccesses.map((call) => call.completedAtMs ?? 0))
        : null;
      return {
        enabled: this.database.globalEnabled ? 1 : 0,
        disabled: user?.disabled ? 1 : user ? 0 : 1,
        used: successful.length,
        reserved: this.database.calls.filter((call) => (
          call.accountKey === accountKey
          && call.status === 'reserved'
          && call.reservationExpiresAtMs > reservationNowMs
        )).length,
        oldest_success: oldestSuccess,
        effective_limit: user?.quotaOverride ?? this.database.defaultLimit,
      } as T;
    }

    throw new Error(`Unexpected first() query: ${this.query}`);
  }

  async run() {
    if (/INSERT\s+INTO\s+agent_users/i.test(this.query)) {
      const [accountKey, provider, role, createdAtMs, lastSeenAtMs] = this.values;
      const key = String(accountKey);
      const existing = this.database.users.get(key);
      this.database.users.set(key, {
        accountKey: key,
        authProvider: provider as AuthPrincipal['provider'],
        role: role as AgentUserRow['role'],
        disabled: existing?.disabled ?? false,
        quotaOverride: existing?.quotaOverride ?? null,
        createdAtMs: existing?.createdAtMs ?? Number(createdAtMs),
        lastSeenAtMs: Number(lastSeenAtMs),
      });
      return { meta: { changes: 1 } };
    }

    if (/INSERT\s+INTO\s+agent_calls/i.test(this.query)) {
      const [
        id,
        accountKeyValue,
        provider,
        isAdminValue,
        idempotencyKeyValue,
        sessionIdValue,
        reservedAtMs,
        reservationExpiresAtMs,
        model,
        requiredAccountKey,
        quotaBypassValue,
        quotaAccountKey,
        successCutoffMs,
        reservationNowMs,
        limitAccountKey,
      ] = this.values;
      const accountKey = String(accountKeyValue);
      const idempotencyKey = String(idempotencyKeyValue);
      const duplicate = this.database.calls.some((call) => (
        call.accountKey === accountKey && call.idempotencyKey === idempotencyKey
      ));
      const user = this.database.users.get(String(requiredAccountKey));
      const quotaUsed = this.database.calls.filter((call) => (
        call.accountKey === String(quotaAccountKey)
        && (
          (call.status === 'success' && (call.completedAtMs ?? 0) > Number(successCutoffMs))
          || (call.status === 'reserved' && call.reservationExpiresAtMs > Number(reservationNowMs))
        )
      )).length;
      const quotaUser = this.database.users.get(String(limitAccountKey));
      const effectiveLimit = quotaUser?.quotaOverride ?? this.database.defaultLimit;
      const allowed = this.database.globalEnabled
        && Boolean(user && !user.disabled)
        && (Number(quotaBypassValue) === 1 || quotaUsed < effectiveLimit)
        && !duplicate;
      if (!allowed) return { meta: { changes: 0 } };

      this.database.calls.push({
        id: String(id),
        accountKey,
        authProvider: provider as AuthPrincipal['provider'],
        isAdmin: Number(isAdminValue) === 1,
        idempotencyKey,
        sessionId: String(sessionIdValue),
        status: 'reserved',
        reservedAtMs: Number(reservedAtMs),
        reservationExpiresAtMs: Number(reservationExpiresAtMs),
        completedAtMs: null,
        model: String(model),
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCostMicroCny: 0,
        latencyMs: 0,
        feedback: null,
        errorClass: null,
      });
      return { meta: { changes: 1 } };
    }

    if (/SET\s+status\s*=\s*'technical_failure'/i.test(this.query)) {
      const [completedAtMs, errorClass, id] = this.values;
      const call = this.database.calls.find((candidate) => candidate.id === String(id));
      if (!call || call.status !== 'reserved') return { meta: { changes: 0 } };
      call.status = 'technical_failure';
      call.completedAtMs = Number(completedAtMs);
      call.errorClass = String(errorClass);
      return { meta: { changes: 1 } };
    }

    if (/SET\s+status\s*=\s*'success'/i.test(this.query)) {
      const [
        completedAtMs,
        model,
        inputTokens,
        outputTokens,
        totalTokens,
        latencyMs,
        id,
        maximumExpiryMs,
      ] = this.values;
      const call = this.database.calls.find((candidate) => candidate.id === String(id));
      if (
        !call
        || call.status !== 'reserved'
        || call.reservationExpiresAtMs < Number(maximumExpiryMs)
      ) {
        return { meta: { changes: 0 } };
      }
      call.status = 'success';
      call.completedAtMs = Number(completedAtMs);
      call.model = String(model);
      call.inputTokens = Number(inputTokens);
      call.outputTokens = Number(outputTokens);
      call.totalTokens = Number(totalTokens);
      call.estimatedCostMicroCny = 0;
      call.latencyMs = Number(latencyMs);
      call.errorClass = null;
      return { meta: { changes: 1 } };
    }

    if (/SET\s+feedback\s*=\s*\?/i.test(this.query)) {
      const [feedback, , id, accountKey] = this.values;
      const call = this.database.calls.find((candidate) => (
        candidate.id === String(id) && candidate.accountKey === String(accountKey)
      ));
      if (!call || call.status !== 'success' || call.feedback !== null) return { meta: { changes: 0 } };
      call.feedback = feedback as AgentCallRow['feedback'];
      return { meta: { changes: 1 } };
    }

    throw new Error(`Unexpected run() query: ${this.query}`);
  }
}

class FakeAgentDatabase {
  globalEnabled = false;
  defaultLimit = AGENT_DAILY_LIMIT;
  readonly users = new Map<string, AgentUserRow>();
  readonly calls: AgentCallRow[] = [];
  readonly applicationStates = new Map<string, string>();

  prepare(query: string) {
    return new FakeStatement(query, this) as unknown as ReturnType<AgentDatabase['prepare']>;
  }

  addSuccessfulCall(accountKey: string, completedAtMs: number, sequence: number) {
    this.calls.push({
      id: `previous-${sequence}`,
      accountKey,
      authProvider: 'chatgpt',
      isAdmin: false,
      idempotencyKey: `previous-key-${sequence}`,
      sessionId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
      status: 'success',
      reservedAtMs: completedAtMs - 1_000,
      reservationExpiresAtMs: completedAtMs + 44_000,
      completedAtMs,
      model: 'test-model',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      estimatedCostMicroCny: 20,
      latencyMs: 1_000,
      feedback: null,
      errorClass: null,
    });
  }
}

const CHATGPT_USER: AuthPrincipal = {
  id: 'chatgpt-stable-user',
  email: 'owner@example.com',
  provider: 'chatgpt',
  subject: 'chatgpt-stable-user',
  displayName: 'owner@example.com',
};

const GITHUB_USER: AuthPrincipal = {
  id: 'github:12345',
  email: '',
  provider: 'github',
  subject: 'chatgpt-stable-user',
  displayName: 'career-user',
};

const CONFIG: AgentRuntimeConfig = {
  apiKey: 'server-only-test-key',
  model: 'test-model',
  adminChatgptUserId: CHATGPT_USER.subject,
};

const NOW_MS = 1_800_000_000_000;
const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function arkSuccess(answer = '建议先完善下一步安排。') {
  return Response.json({
    model: 'test-model-response',
    output: [{
      content: [{ type: 'output_text', text: answer }],
    }],
    usage: {
      input_tokens: 120,
      output_tokens: 40,
      total_tokens: 160,
    },
  });
}

test('only the exact ChatGPT stable subject can be admin; GitHub is never admin', () => {
  assert.equal(isAgentAdmin(CHATGPT_USER, 'chatgpt-stable-user'), true);
  assert.equal(isAgentAdmin({ ...CHATGPT_USER, subject: 'chatgpt-stable-user-extra' }, 'chatgpt-stable-user'), false);
  assert.equal(isAgentAdmin({ ...CHATGPT_USER, subject: 'CHATGPT-STABLE-USER' }, 'chatgpt-stable-user'), false);
  assert.equal(isAgentAdmin(GITHUB_USER, 'chatgpt-stable-user'), false);
  assert.equal(isAgentAdmin(CHATGPT_USER, ''), false);
});

test('question normalization accepts 800 characters and rejects longer or non-string values', () => {
  assert.equal(normalizeAgentQuestion(`  ${'问'.repeat(AGENT_MAX_QUESTION_LENGTH)}  `), '问'.repeat(AGENT_MAX_QUESTION_LENGTH));
  assert.equal(normalizeAgentQuestion('问'.repeat(AGENT_MAX_QUESTION_LENGTH + 1)), '');
  assert.equal(normalizeAgentQuestion('  下一步\u0000怎么做？  '), '下一步 怎么做？');
  assert.equal(normalizeAgentQuestion({ question: 'not a string' }), '');
});

test('Ark response parsing extracts answer and safe usage without trusting malformed values', () => {
  assert.deepEqual(parseArkResponse({
    model: 'doubao-test',
    output: [{ content: [{ type: 'output_text', text: '先补充投递日期。' }] }],
    usage: { input_tokens: 21, output_tokens: 9 },
  }), {
    answer: '先补充投递日期。',
    usage: { inputTokens: 21, outputTokens: 9, totalTokens: 30 },
    model: 'doubao-test',
  });
  assert.deepEqual(parseArkResponse({
    output_text: '信息不足。',
    usage: { input_tokens: -10, output_tokens: '9', total_tokens: Number.NaN },
  }), {
    answer: '信息不足。',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    model: '',
  });
  assert.equal(parseArkResponse({ output: [{ content: [] }] }), null);
});

test('high-confidence CRUD and read requests select one controlled tool', () => {
  assert.equal(preferredAgentTool('帮我添加一个京东的 AI 产品经理岗位'), 'propose_add_job');
  assert.equal(preferredAgentTool('查看星河能源的岗位'), 'query_applications');
  assert.equal(preferredAgentTool('把这个岗位的状态改为一面'), 'propose_update_job');
  assert.equal(preferredAgentTool('删除这家公司'), 'propose_delete_company');
  assert.equal(preferredAgentTool('我下一步应该做什么？'), null);
});

test('global emergency switch blocks upstream calls and creates no call record', async () => {
  const database = new FakeAgentDatabase();
  let upstreamCalls = 0;
  const result = await runAgentQuery({
    database,
    principal: CHATGPT_USER,
    config: CONFIG,
    question: '我下一步应该做什么？',
    idempotencyKey: 'disabled-request',
    sessionId: SESSION_ID,
    now: () => NOW_MS,
    fetcher: (async () => {
      upstreamCalls += 1;
      return arkSuccess();
    }) as typeof fetch,
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'disabled');
  assert.equal(upstreamCalls, 0);
  assert.equal(database.calls.length, 0);
});

test('technical upstream failure is audited but does not consume a successful-use quota', async () => {
  const database = new FakeAgentDatabase();
  database.globalEnabled = true;
  const result = await runAgentQuery({
    database,
    principal: CHATGPT_USER,
    config: CONFIG,
    question: '帮我分析当前优先级。',
    idempotencyKey: 'failed-request',
    sessionId: SESSION_ID,
    now: () => NOW_MS,
    fetcher: (async () => new Response('provider unavailable', { status: 503 })) as typeof fetch,
  });

  assert.deepEqual(result, {
    ok: false,
    code: 'technical_failure',
    message: AGENT_TECHNICAL_FAILURE_MESSAGE,
  });
  assert.equal(database.calls.length, 1);
  assert.equal(database.calls[0].status, 'technical_failure');
  assert.equal(database.calls[0].errorClass, 'ark_http_503');
  const status = await getAgentUserStatus(database, CHATGPT_USER, CONFIG, NOW_MS);
  assert.equal(status.used, 0);
  assert.equal(status.remaining, null, 'admin remains unlimited');
});

test('successful response consumes one use and records model and tokens without calculating a new cost', async () => {
  const database = new FakeAgentDatabase();
  database.globalEnabled = true;
  const ordinaryUser = { ...CHATGPT_USER, id: 'chatgpt-ordinary', subject: 'chatgpt-ordinary' };
  database.applicationStates.set(ordinaryUser.id, JSON.stringify({
    companies: [{
      name: '示例能源',
      jobs: [{ title: '产品工程师', stage: '已投递', notes: '等待通知' }],
    }],
  }));
  let requestBody = '';
  const result = await runAgentQuery({
    database,
    principal: ordinaryUser,
    config: CONFIG,
    question: '我现在最应该跟进哪个岗位？',
    idempotencyKey: 'successful-request',
    sessionId: SESSION_ID,
    now: () => NOW_MS,
    fetcher: (async (_input, init) => {
      requestBody = String(init?.body ?? '');
      return arkSuccess('优先跟进已投递岗位。');
    }) as typeof fetch,
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.answer, '优先跟进已投递岗位。');
    assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 40, totalTokens: 160 });
    assert.equal('estimatedCostMicroCny' in result, false);
    assert.equal(result.status.used, 1);
    assert.equal(result.status.limit, AGENT_DAILY_LIMIT);
    assert.equal(result.status.remaining, AGENT_DAILY_LIMIT - 1);
  }
  assert.match(requestBody, /我现在最应该跟进哪个岗位/);
  assert.match(requestBody, /示例能源/);
  assert.equal(database.calls.length, 1);
  assert.deepEqual({
    status: database.calls[0].status,
    model: database.calls[0].model,
    inputTokens: database.calls[0].inputTokens,
    outputTokens: database.calls[0].outputTokens,
    totalTokens: database.calls[0].totalTokens,
    estimatedCostMicroCny: database.calls[0].estimatedCostMicroCny,
  }, {
    status: 'success',
    model: 'test-model-response',
    inputTokens: 120,
    outputTokens: 40,
    totalTokens: 160,
    estimatedCostMicroCny: 0,
  });
  assert.equal('question' in database.calls[0], false);
  assert.equal('answer' in database.calls[0], false);
});

test('explicit CRUD sends one forced tool with a compact prompt instead of the full account context', async () => {
  const database = new FakeAgentDatabase();
  database.globalEnabled = true;
  const ordinaryUser = { ...CHATGPT_USER, id: 'chatgpt-forced-tool', subject: 'chatgpt-forced-tool' };
  database.applicationStates.set(ordinaryUser.id, JSON.stringify({
    companies: [{ name: '不应发送的公司', jobs: [{ title: '不应发送的岗位', stage: '已投递' }] }],
  }));
  let body: Record<string, unknown> = {};
  const result = await runAgentQuery({
    database, principal: ordinaryUser, config: CONFIG,
    question: '帮我添加一个京东的 AI 产品经理岗位',
    idempotencyKey: 'forced-tool-request', sessionId: SESSION_ID, now: () => NOW_MS,
    fetcher: (async (_input, init) => {
      body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return arkSuccess('模拟服务商未遵守强制工具，仅用于检查请求体。');
    }) as typeof fetch,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(body.tool_choice, { type: 'function', name: 'propose_add_job' });
  assert.equal(Array.isArray(body.tools) ? body.tools.length : 0, 1);
  assert.equal(body.max_output_tokens, 320);
  assert.doesNotMatch(JSON.stringify(body.input), /不应发送的公司|不应发送的岗位/);
});

test('ordinary-user status and atomic reservation use the current default or per-user override', async () => {
  const database = new FakeAgentDatabase();
  database.globalEnabled = true;
  database.defaultLimit = 2;
  const ordinaryUser = { ...CHATGPT_USER, id: 'chatgpt-custom-limit', subject: 'chatgpt-custom-limit' };

  const initial = await getAgentUserStatus(database, ordinaryUser, CONFIG, NOW_MS);
  assert.equal(initial.limit, 2);
  assert.equal(initial.remaining, 2);

  const user = database.users.get(ordinaryUser.id);
  assert.ok(user);
  user.quotaOverride = 1;
  database.addSuccessfulCall(ordinaryUser.id, NOW_MS - 1_000, 90);

  const overridden = await getAgentUserStatus(database, ordinaryUser, CONFIG, NOW_MS);
  assert.equal(overridden.limit, 1);
  assert.equal(overridden.used, 1);
  assert.equal(overridden.remaining, 0);

  let upstreamCalls = 0;
  const result = await runAgentQuery({
    database,
    principal: ordinaryUser,
    config: CONFIG,
    question: '还能分析吗？',
    idempotencyKey: 'overridden-limit-request',
    sessionId: '44444444-4444-4444-8444-444444444444',
    now: () => NOW_MS,
    fetcher: (async () => {
      upstreamCalls += 1;
      return arkSuccess();
    }) as typeof fetch,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'quota_exhausted');
  assert.equal(upstreamCalls, 0);
});

test('administrator stays unlimited even when the ordinary-user default limit is zero', async () => {
  const database = new FakeAgentDatabase();
  database.globalEnabled = true;
  database.defaultLimit = 0;
  const status = await getAgentUserStatus(database, CHATGPT_USER, CONFIG, NOW_MS);
  assert.equal(status.isAdmin, true);
  assert.equal(status.limit, null);
  assert.equal(status.remaining, null);

  const result = await runAgentQuery({
    database,
    principal: CHATGPT_USER,
    config: CONFIG,
    question: '管理员分析',
    idempotencyKey: 'admin-zero-default',
    sessionId: '55555555-5555-4555-8555-555555555555',
    now: () => NOW_MS,
    fetcher: (async () => arkSuccess()) as typeof fetch,
  });
  assert.equal(result.ok, true);
});

test('atomic reservation permits only one concurrent request for the final rolling-24h slot', async () => {
  const database = new FakeAgentDatabase();
  database.globalEnabled = true;
  const ordinaryUser = { ...CHATGPT_USER, id: 'chatgpt-concurrent', subject: 'chatgpt-concurrent' };
  for (let index = 0; index < AGENT_DAILY_LIMIT - 1; index += 1) {
    database.addSuccessfulCall(ordinaryUser.id, NOW_MS - AGENT_WINDOW_MS + 10_000 + index, index);
  }
  let upstreamCalls = 0;
  const fetcher = (async () => {
    upstreamCalls += 1;
    await Promise.resolve();
    return arkSuccess();
  }) as typeof fetch;

  const [first, second] = await Promise.all([
    runAgentQuery({
      database,
      principal: ordinaryUser,
      config: CONFIG,
      question: '请求一',
      idempotencyKey: 'concurrent-one',
      sessionId: SESSION_ID,
      now: () => NOW_MS,
      fetcher,
    }),
    runAgentQuery({
      database,
      principal: ordinaryUser,
      config: CONFIG,
      question: '请求二',
      idempotencyKey: 'concurrent-two',
      sessionId: SESSION_ID,
      now: () => NOW_MS,
      fetcher,
    }),
  ]);

  assert.equal([first, second].filter((result) => result.ok).length, 1);
  assert.equal(
    [first, second].filter((result) => !result.ok && result.code === 'quota_exhausted').length,
    1,
  );
  assert.equal(upstreamCalls, 1);
  assert.equal(database.calls.filter((call) => call.status === 'success').length, AGENT_DAILY_LIMIT);
});

test('Agent context is read only from the authenticated account and excludes free-text notes', async () => {
  const database = new FakeAgentDatabase();
  database.globalEnabled = true;
  const firstUser = { ...CHATGPT_USER, id: 'chatgpt-first', subject: 'chatgpt-first' };
  const secondUser = { ...CHATGPT_USER, id: 'chatgpt-second', subject: 'chatgpt-second' };
  database.applicationStates.set(firstUser.id, JSON.stringify({
    companies: [{ name: '甲方能源', jobs: [{ title: '甲方岗位标记', stage: '已投递', notes: '联系人电话 123456' }] }],
  }));
  database.applicationStates.set(secondUser.id, JSON.stringify({
    companies: [{ name: '乙方能源', jobs: [{ title: '乙方岗位标记', stage: '一面', notes: '不应发送的备注正文' }] }],
  }));
  let requestBody = '';

  const result = await runAgentQuery({
    database,
    principal: secondUser,
    config: CONFIG,
    question: '分析乙方岗位标记',
    idempotencyKey: 'isolated-context',
    sessionId: '22222222-2222-4222-8222-222222222222',
    now: () => NOW_MS,
    fetcher: (async (_input, init) => {
      requestBody = String(init?.body ?? '');
      return arkSuccess();
    }) as typeof fetch,
  });

  assert.equal(result.ok, true);
  assert.match(requestBody, /乙方岗位标记/);
  assert.doesNotMatch(requestBody, /甲方岗位标记/);
  assert.doesNotMatch(requestBody, /不应发送的备注正文|联系人电话/);
});

test('feedback is saved once for the authenticated owner without storing answer text', async () => {
  const database = new FakeAgentDatabase();
  database.globalEnabled = true;
  const ordinaryUser = { ...CHATGPT_USER, id: 'chatgpt-feedback', subject: 'chatgpt-feedback' };
  const result = await runAgentQuery({
    database,
    principal: ordinaryUser,
    config: CONFIG,
    question: '给我建议',
    idempotencyKey: 'feedback-request',
    sessionId: '33333333-3333-4333-8333-333333333333',
    now: () => NOW_MS,
    fetcher: (async () => arkSuccess()) as typeof fetch,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(await recordAgentFeedback(database, ordinaryUser, result.callId, 'resolved', NOW_MS + 1), true);
  assert.equal(await recordAgentFeedback(database, ordinaryUser, result.callId, 'unresolved', NOW_MS + 2), false);
  assert.equal(database.calls[0].feedback, 'resolved');
});
