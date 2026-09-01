import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudStateHandlers, MAX_STATE_BYTES } from './cloud-state-handlers.ts';
import type { StateDatabase, StateRow, StateStatement } from './cloud-state-service.ts';
import { MAX_AUTHENTICATED_USER_ID_LENGTH } from './user-scope.ts';

type FakeRow = StateRow & { user_email: string };

class FakeStatement implements StateStatement {
  private values: unknown[] = [];
  private readonly query: string;
  private readonly rows: Map<string, FakeRow>;

  constructor(query: string, rows: Map<string, FakeRow>) {
    this.query = query;
    this.rows = rows;
  }

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>() {
    if (!/SELECT\s+data_json/i.test(this.query)) throw new Error('Unexpected first() query.');
    const row = this.rows.get(String(this.values[0]));
    return (row ? structuredClone(row) : null) as T | null;
  }

  async run() {
    if (/INSERT OR IGNORE/i.test(this.query)) {
      const userId = String(this.values[0]);
      if (this.rows.has(userId)) return { meta: { changes: 0 } };
      const isDelete = /VALUES\s*\(\?,\s*''/i.test(this.query);
      this.rows.set(userId, isDelete
        ? {
          user_email: '',
          data_json: String(this.values[1]),
          updated_at: String(this.values[2]),
          version: String(this.values[3]),
          deleted_at: String(this.values[4]),
        }
        : {
          user_email: String(this.values[1]),
          data_json: String(this.values[2]),
          updated_at: String(this.values[3]),
          version: String(this.values[4]),
          deleted_at: null,
        });
      return { meta: { changes: 1 } };
    }

    if (/UPDATE\s+application_states/i.test(this.query)) {
      const isDelete = /deleted_at\s*=\s*\?/i.test(this.query);
      const userId = String(this.values[4]);
      const baseVersion = String(this.values[5]);
      const current = this.rows.get(userId);
      if (!current || current.version !== baseVersion) return { meta: { changes: 0 } };
      this.rows.set(userId, isDelete
        ? {
          user_email: '',
          data_json: String(this.values[0]),
          updated_at: String(this.values[1]),
          version: String(this.values[2]),
          deleted_at: String(this.values[3]),
        }
        : {
          user_email: String(this.values[0]),
          data_json: String(this.values[1]),
          updated_at: String(this.values[2]),
          version: String(this.values[3]),
          deleted_at: null,
        });
      return { meta: { changes: 1 } };
    }

    throw new Error(`Unexpected run() query: ${this.query}`);
  }
}

class FakeDatabase implements StateDatabase {
  readonly rows = new Map<string, FakeRow>();
  prepareCalls = 0;

  prepare(query: string) {
    this.prepareCalls += 1;
    return new FakeStatement(query, this.rows);
  }
}

function applicationState(label: string) {
  return {
    companies: [{
      id: `company-${label}`,
      name: `公司 ${label}`,
      shortName: label,
      website: '',
      color: '#275A53',
      note: '',
      jobs: [],
    }],
  };
}

function apiRequest(
  method: 'GET' | 'PUT' | 'DELETE',
  userId: string,
  options: {
    email?: string;
    expectedUserId?: string;
    baseVersion?: string;
    body?: unknown;
    rawBody?: BodyInit;
  } = {},
) {
  const headers = new Headers({
    'oai-authenticated-user-id': userId,
    'oai-authenticated-user-email': options.email ?? '',
  });
  if (options.expectedUserId !== undefined) headers.set('x-expected-user-id', options.expectedUserId);
  if (options.baseVersion !== undefined) headers.set('x-state-base-version', options.baseVersion);
  let body = options.rawBody;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers.set('content-type', 'application/json');
  }
  const init = { method, headers, body } as RequestInit & { duplex?: 'half' };
  if (body instanceof ReadableStream) init.duplex = 'half';
  return new Request('https://example.com/api/state', init);
}

async function payload<T>(response: Response) {
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  return await response.json() as T;
}

test('A/B 用户、相同邮箱、账号切换和删除始终严格隔离', async () => {
  const database = new FakeDatabase();
  let versionSequence = 0;
  const handlers = createCloudStateHandlers({
    database: () => database,
    ensureSchema: async () => undefined,
    now: () => '2026-08-31T00:00:00.000Z',
    randomId: () => `version-${++versionSequence}`,
  });
  const sharedEmail = 'shared@example.com';

  const savedAResponse = await handlers.PUT(apiRequest('PUT', 'user-a', {
    email: sharedEmail,
    expectedUserId: 'user-a',
    baseVersion: 'none',
    body: applicationState('A'),
  }));
  assert.equal(savedAResponse.status, 200);
  const savedA = await payload<{ version: string }>(savedAResponse);

  const savedBResponse = await handlers.PUT(apiRequest('PUT', 'user-b', {
    email: sharedEmail,
    expectedUserId: 'user-b',
    baseVersion: 'none',
    body: applicationState('B'),
  }));
  assert.equal(savedBResponse.status, 200);
  const savedB = await payload<{ version: string }>(savedBResponse);

  const stateA = await payload<{ state: unknown }>(await handlers.GET(apiRequest('GET', 'user-a')));
  const stateB = await payload<{ state: unknown }>(await handlers.GET(apiRequest('GET', 'user-b')));
  assert.deepEqual(stateA.state, applicationState('A'));
  assert.deepEqual(stateB.state, applicationState('B'));
  assert.notDeepEqual(stateA.state, stateB.state);

  const callsBeforeSwitch = database.prepareCalls;
  const switched = await handlers.PUT(apiRequest('PUT', 'user-b', {
    email: sharedEmail,
    expectedUserId: 'user-a',
    baseVersion: savedA.version,
    body: applicationState('stale-A'),
  }));
  assert.equal(switched.status, 409);
  assert.deepEqual(await payload(switched), { error: 'account_context_changed' });
  assert.equal(database.prepareCalls, callsBeforeSwitch, '账号切换后不应读请求体或访问 D1');

  const switchedDelete = await handlers.DELETE(apiRequest('DELETE', 'user-b', {
    expectedUserId: 'user-a',
    baseVersion: savedA.version,
  }));
  assert.equal(switchedDelete.status, 409);
  assert.deepEqual(await payload(switchedDelete), { error: 'account_context_changed' });
  assert.equal(database.prepareCalls, callsBeforeSwitch, '账号切换后 DELETE 也不应访问 D1');

  const deletedAResponse = await handlers.DELETE(apiRequest('DELETE', 'user-a', {
    expectedUserId: 'user-a',
    baseVersion: savedA.version,
  }));
  assert.equal(deletedAResponse.status, 200);
  await payload(deletedAResponse);

  const deletedA = await payload<{ state: unknown }>(await handlers.GET(apiRequest('GET', 'user-a')));
  const untouchedB = await payload<{ state: unknown; version: string }>(
    await handlers.GET(apiRequest('GET', 'user-b')),
  );
  assert.equal(deletedA.state, null);
  assert.deepEqual(untouchedB.state, applicationState('B'));
  assert.equal(untouchedB.version, savedB.version);
});

test('非法认证 ID 被拒绝，且实际超大流不进入 D1', async () => {
  const database = new FakeDatabase();
  const handlers = createCloudStateHandlers({
    database: () => database,
    ensureSchema: async () => undefined,
  });

  const invalidId = await handlers.GET(apiRequest(
    'GET',
    'x'.repeat(MAX_AUTHENTICATED_USER_ID_LENGTH + 1),
  ));
  assert.equal(invalidId.status, 401);
  assert.deepEqual(await payload(invalidId), { error: 'sign_in_required' });
  assert.equal(database.prepareCalls, 0);

  const oversizedStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_STATE_BYTES));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  });
  const oversized = apiRequest('PUT', 'user-a', {
    expectedUserId: 'user-a',
    baseVersion: 'none',
    rawBody: oversizedStream,
  });
  const oversizedResponse = await handlers.PUT(oversized);
  assert.equal(oversizedResponse.status, 413);
  assert.deepEqual(await payload(oversizedResponse), { error: 'state_too_large' });
  assert.equal(database.prepareCalls, 0);
});
