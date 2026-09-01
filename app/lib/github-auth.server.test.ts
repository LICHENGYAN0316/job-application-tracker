import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGithubAuthHandlers,
  GITHUB_OAUTH_STATE_COOKIE,
  GITHUB_SESSION_COOKIE,
  requestCookie,
  resolveGithubSession,
  sha256Base64Url,
  type GithubAuthDatabase,
  type GithubAuthStatement,
} from './github-auth.server.ts';
import {
  AuthPrincipalConflictError,
  resolveAuthPrincipal,
} from './auth-principal.server.ts';

type OauthStateRow = {
  state_hash: string;
  code_verifier: string;
  redirect_uri: string;
  created_at_ms: number;
  expires_at_ms: number;
  consumed_at_ms: number | null;
};

type SessionRow = {
  session_hash: string;
  account_key: string;
  github_subject: string;
  display_login: string;
  created_at_ms: number;
  expires_at_ms: number;
  revoked_at_ms: number | null;
};

class FakeStatement implements GithubAuthStatement {
  private values: unknown[] = [];
  private readonly query: string;
  private readonly database: FakeDatabase;

  constructor(query: string, database: FakeDatabase) {
    this.query = query;
    this.database = database;
  }

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>() {
    if (/FROM\s+github_oauth_states/i.test(this.query)) {
      return (this.database.oauthStates.get(String(this.values[0])) ?? null) as T | null;
    }
    if (/FROM\s+github_sessions/i.test(this.query)) {
      return (this.database.sessions.get(String(this.values[0])) ?? null) as T | null;
    }
    throw new Error(`Unexpected first query: ${this.query}`);
  }

  async run() {
    if (/DELETE FROM\s+github_oauth_states/i.test(this.query)) {
      if (this.database.failCleanup) throw new Error('Simulated OAuth state cleanup failure');
      const timestamp = Number(this.values[0]);
      let changes = 0;
      for (const [key, row] of this.database.oauthStates) {
        if (row.expires_at_ms <= timestamp || row.consumed_at_ms !== null) {
          this.database.oauthStates.delete(key);
          changes += 1;
        }
      }
      return { meta: { changes } };
    }

    if (/DELETE FROM\s+github_sessions/i.test(this.query)) {
      if (this.database.failCleanup) throw new Error('Simulated GitHub session cleanup failure');
      const timestamp = Number(this.values[0]);
      let changes = 0;
      for (const [key, row] of this.database.sessions) {
        if (row.expires_at_ms <= timestamp || row.revoked_at_ms !== null) {
          this.database.sessions.delete(key);
          changes += 1;
        }
      }
      return { meta: { changes } };
    }

    if (/INSERT INTO\s+github_oauth_states/i.test(this.query)) {
      const [stateHash, verifier, redirectUri, createdAt, expiresAt] = this.values;
      this.database.oauthStates.set(String(stateHash), {
        state_hash: String(stateHash),
        code_verifier: String(verifier),
        redirect_uri: String(redirectUri),
        created_at_ms: Number(createdAt),
        expires_at_ms: Number(expiresAt),
        consumed_at_ms: null,
      });
      return { meta: { changes: 1 } };
    }

    if (/UPDATE\s+github_oauth_states/i.test(this.query)) {
      const [consumedAt, stateHash, minimumExpiry] = this.values;
      const row = this.database.oauthStates.get(String(stateHash));
      if (!row || row.consumed_at_ms !== null || row.expires_at_ms <= Number(minimumExpiry)) {
        return { meta: { changes: 0 } };
      }
      row.consumed_at_ms = Number(consumedAt);
      return { meta: { changes: 1 } };
    }

    if (/INSERT INTO\s+github_sessions/i.test(this.query)) {
      const [sessionHash, accountKey, subject, login, createdAt, expiresAt] = this.values;
      this.database.sessions.set(String(sessionHash), {
        session_hash: String(sessionHash),
        account_key: String(accountKey),
        github_subject: String(subject),
        display_login: String(login),
        created_at_ms: Number(createdAt),
        expires_at_ms: Number(expiresAt),
        revoked_at_ms: null,
      });
      return { meta: { changes: 1 } };
    }

    if (/UPDATE\s+github_sessions/i.test(this.query)) {
      const [revokedAt, sessionHash] = this.values;
      const row = this.database.sessions.get(String(sessionHash));
      if (!row || row.revoked_at_ms !== null) return { meta: { changes: 0 } };
      row.revoked_at_ms = Number(revokedAt);
      return { meta: { changes: 1 } };
    }

    throw new Error(`Unexpected run query: ${this.query}`);
  }
}

class FakeDatabase implements GithubAuthDatabase {
  readonly oauthStates = new Map<string, OauthStateRow>();
  readonly sessions = new Map<string, SessionRow>();
  failCleanup = false;

  prepare(query: string) {
    return new FakeStatement(query, this);
  }
}

function cookieValue(response: Response, name: string) {
  const match = response.headers.get('set-cookie')?.match(new RegExp(`${name}=([^;,]*)`));
  assert.ok(match, `${name} cookie should be present`);
  return decodeURIComponent(match[1]);
}

function deterministicRandom() {
  let call = 0;
  return (length: number) => {
    call += 1;
    return new Uint8Array(length).fill(call * 17);
  };
}

function dependencies(
  database: FakeDatabase,
  requestFetch: typeof fetch = fetch,
  providerTimeoutMs = 5_000,
) {
  return {
    database: () => database,
    ensureSchema: async () => undefined,
    configuration: () => ({
      clientId: 'github-client-id',
      clientSecret: 'github-client-secret',
      publicAppOrigin: 'https://example.com',
    }),
    fetch: requestFetch,
    providerTimeoutMs,
    now: () => 1_800_000_000_000,
    randomBytes: deterministicRandom(),
  };
}

test('start uses state + S256 PKCE, requests no scopes, and stores only the state hash', async () => {
  const database = new FakeDatabase();
  const handlers = createGithubAuthHandlers(dependencies(database));
  const response = await handlers.START();

  assert.equal(response.status, 303);
  const location = new URL(response.headers.get('location') ?? '');
  assert.equal(location.origin, 'https://github.com');
  assert.equal(location.pathname, '/login/oauth/authorize');
  assert.equal(location.searchParams.get('client_id'), 'github-client-id');
  assert.equal(location.searchParams.get('redirect_uri'), 'https://example.com/api/auth/github/callback');
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(location.searchParams.get('code_challenge'));
  assert.equal(location.searchParams.has('scope'), false, 'identity login must not request repo scope');

  const state = location.searchParams.get('state') ?? '';
  assert.equal(cookieValue(response, GITHUB_OAUTH_STATE_COOKIE), state);
  const setCookie = response.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, /Path=\//i);
  assert.equal(database.oauthStates.has(state), false, 'raw state must not be stored in D1');
  assert.ok(database.oauthStates.has(await sha256Base64Url(state)));
});

test('callback consumes state once, discards provider token, and creates a hashed GitHub session', async () => {
  const database = new FakeDatabase();
  const requests: Array<{ url: string; authorization: string; body: string }> = [];
  const requestFetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      url,
      authorization: new Headers(init?.headers).get('authorization') ?? '',
      body: String(init?.body ?? ''),
    });
    if (url.includes('/access_token')) {
      return Response.json({ access_token: 'temporary-provider-token', token_type: 'bearer' });
    }
    return Response.json({ id: 123456789, login: 'career-user' });
  }) as typeof fetch;
  const handlers = createGithubAuthHandlers(dependencies(database, requestFetch));

  const start = await handlers.START();
  const authorizationUrl = new URL(start.headers.get('location') ?? '');
  const state = authorizationUrl.searchParams.get('state') ?? '';
  const stateCookie = cookieValue(start, GITHUB_OAUTH_STATE_COOKIE);
  const callback = new Request(
    `https://example.com/api/auth/github/callback?code=one-time-code&state=${encodeURIComponent(state)}`,
    { headers: { cookie: `${GITHUB_OAUTH_STATE_COOKIE}=${encodeURIComponent(stateCookie)}` } },
  );
  const response = await handlers.CALLBACK(callback);

  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get('location') ?? '').searchParams.get('github_auth'), 'success');
  assert.equal(database.oauthStates.get(await sha256Base64Url(state))?.consumed_at_ms, 1_800_000_000_000);
  assert.equal(requests.length, 2);
  assert.match(requests[0].body, /code_verifier=/);
  assert.doesNotMatch(requests[0].body, /scope=/);
  assert.equal(requests[1].authorization, 'Bearer temporary-provider-token');

  const sessionToken = cookieValue(response, GITHUB_SESSION_COOKIE);
  assert.equal(database.sessions.has(sessionToken), false, 'raw session token must not be stored in D1');
  const stored = database.sessions.get(await sha256Base64Url(sessionToken));
  assert.equal(stored?.account_key, 'github:123456789');
  assert.equal(stored?.github_subject, '123456789');
  assert.equal(stored?.display_login, 'career-user');
  assert.equal(JSON.stringify([...database.sessions.values()]).includes('temporary-provider-token'), false);

  const sessionRequest = new Request('https://example.com/api/auth/github/session', {
    headers: { cookie: `${GITHUB_SESSION_COOKIE}=${encodeURIComponent(sessionToken)}` },
  });
  assert.deepEqual(await resolveGithubSession(sessionRequest, database, 1_800_000_000_001), {
    id: 'github:123456789',
    email: '',
    provider: 'github',
    subject: '123456789',
    displayName: 'career-user',
  });

  const replay = await handlers.CALLBACK(callback);
  assert.equal(new URL(replay.headers.get('location') ?? '').searchParams.get('github_auth'), 'failed');
  assert.equal(requests.length, 2, 'replayed callback must be rejected before calling GitHub');
});

for (const timeoutAt of ['token exchange', 'user fetch'] as const) {
  test(`callback fails closed when GitHub ${timeoutAt} times out`, async () => {
    const database = new FakeDatabase();
    let requestCount = 0;
    const requestFetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      requestCount += 1;
      const url = String(input);
      if (timeoutAt === 'user fetch' && url.includes('/access_token')) {
        return Response.json({ access_token: 'temporary-provider-token' });
      }

      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        assert.ok(signal, 'GitHub provider requests must carry a timeout signal');
        const rejectAsAborted = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        if (signal.aborted) rejectAsAborted();
        else signal.addEventListener('abort', rejectAsAborted, { once: true });
      });
    }) as typeof fetch;
    const handlers = createGithubAuthHandlers(dependencies(database, requestFetch, 5));

    const start = await handlers.START();
    const authorizationUrl = new URL(start.headers.get('location') ?? '');
    const state = authorizationUrl.searchParams.get('state') ?? '';
    const stateCookie = cookieValue(start, GITHUB_OAUTH_STATE_COOKIE);
    const callback = new Request(
      `https://example.com/api/auth/github/callback?code=one-time-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `${GITHUB_OAUTH_STATE_COOKIE}=${encodeURIComponent(stateCookie)}` } },
    );
    const response = await handlers.CALLBACK(callback);

    assert.equal(response.status, 303);
    assert.equal(new URL(response.headers.get('location') ?? '').searchParams.get('github_auth'), 'failed');
    assert.equal(requestCount, timeoutAt === 'token exchange' ? 1 : 2);
    assert.equal(database.sessions.size, 0);
  });
}

test('start removes stale auth records but preserves active records', async () => {
  const database = new FakeDatabase();
  database.oauthStates.set('expired-state', {
    state_hash: 'expired-state',
    code_verifier: 'v'.repeat(43),
    redirect_uri: 'https://example.com/api/auth/github/callback',
    created_at_ms: 1,
    expires_at_ms: 1_799_999_999_999,
    consumed_at_ms: null,
  });
  database.oauthStates.set('consumed-state', {
    state_hash: 'consumed-state',
    code_verifier: 'v'.repeat(43),
    redirect_uri: 'https://example.com/api/auth/github/callback',
    created_at_ms: 1,
    expires_at_ms: 1_800_000_100_000,
    consumed_at_ms: 2,
  });
  database.oauthStates.set('active-state', {
    state_hash: 'active-state',
    code_verifier: 'v'.repeat(43),
    redirect_uri: 'https://example.com/api/auth/github/callback',
    created_at_ms: 1,
    expires_at_ms: 1_800_000_100_000,
    consumed_at_ms: null,
  });
  database.sessions.set('expired-session', {
    session_hash: 'expired-session',
    account_key: 'github:1',
    github_subject: '1',
    display_login: 'one',
    created_at_ms: 1,
    expires_at_ms: 1_800_000_000_000,
    revoked_at_ms: null,
  });
  database.sessions.set('revoked-session', {
    session_hash: 'revoked-session',
    account_key: 'github:2',
    github_subject: '2',
    display_login: 'two',
    created_at_ms: 1,
    expires_at_ms: 1_800_000_100_000,
    revoked_at_ms: 2,
  });
  database.sessions.set('active-session', {
    session_hash: 'active-session',
    account_key: 'github:3',
    github_subject: '3',
    display_login: 'three',
    created_at_ms: 1,
    expires_at_ms: 1_800_000_100_000,
    revoked_at_ms: null,
  });

  const response = await createGithubAuthHandlers(dependencies(database)).START();

  assert.equal(response.status, 303);
  assert.equal(database.oauthStates.has('expired-state'), false);
  assert.equal(database.oauthStates.has('consumed-state'), false);
  assert.equal(database.oauthStates.has('active-state'), true);
  assert.equal(database.sessions.has('expired-session'), false);
  assert.equal(database.sessions.has('revoked-session'), false);
  assert.equal(database.sessions.has('active-session'), true);
});

test('cleanup failure does not block a valid GitHub login', async () => {
  const database = new FakeDatabase();
  database.failCleanup = true;
  const requestFetch = (async (input: URL | RequestInfo) => {
    if (String(input).includes('/access_token')) {
      return Response.json({ access_token: 'temporary-provider-token' });
    }
    return Response.json({ id: 987654321, login: 'cleanup-safe-user' });
  }) as typeof fetch;
  const handlers = createGithubAuthHandlers(dependencies(database, requestFetch));

  const start = await handlers.START();
  assert.equal(start.status, 303);
  const authorizationUrl = new URL(start.headers.get('location') ?? '');
  const state = authorizationUrl.searchParams.get('state') ?? '';
  const stateCookie = cookieValue(start, GITHUB_OAUTH_STATE_COOKIE);
  const callback = new Request(
    `https://example.com/api/auth/github/callback?code=one-time-code&state=${encodeURIComponent(state)}`,
    { headers: { cookie: `${GITHUB_OAUTH_STATE_COOKIE}=${encodeURIComponent(stateCookie)}` } },
  );

  const response = await handlers.CALLBACK(callback);

  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get('location') ?? '').searchParams.get('github_auth'), 'success');
  assert.equal(database.sessions.size, 1);
});

test('principal resolution preserves old ChatGPT keys and never merges ChatGPT with GitHub by email', async () => {
  const database = new FakeDatabase();
  const chatgptRequest = new Request('https://example.com/api/state', {
    headers: {
      'oai-authenticated-user-id': 'chatgpt-stable-id',
      'oai-authenticated-user-email': 'same@example.com',
    },
  });
  assert.deepEqual(await resolveAuthPrincipal(chatgptRequest, database, { now: 1 }), {
    id: 'chatgpt-stable-id',
    email: 'same@example.com',
    provider: 'chatgpt',
    subject: 'chatgpt-stable-id',
    displayName: 'same@example.com',
  });

  const sessionToken = 's'.repeat(43);
  database.sessions.set(await sha256Base64Url(sessionToken), {
    session_hash: await sha256Base64Url(sessionToken),
    account_key: 'github:42',
    github_subject: '42',
    display_login: 'same-email-user',
    created_at_ms: 1,
    expires_at_ms: 10_000,
    revoked_at_ms: null,
  });
  const both = new Request('https://example.com/api/state', {
    headers: {
      cookie: `${GITHUB_SESSION_COOKIE}=${sessionToken}`,
      'oai-authenticated-user-id': 'chatgpt-stable-id',
      'oai-authenticated-user-email': 'same@example.com',
    },
  });
  await assert.rejects(
    resolveAuthPrincipal(both, database, { now: 2 }),
    AuthPrincipalConflictError,
  );
});

test('signout is same-origin POST, removes the revoked session, and clears the cookie', async () => {
  const database = new FakeDatabase();
  const token = 't'.repeat(43);
  const hash = await sha256Base64Url(token);
  database.sessions.set(hash, {
    session_hash: hash,
    account_key: 'github:9',
    github_subject: '9',
    display_login: 'nine',
    created_at_ms: 1,
    expires_at_ms: 2_000_000_000_000,
    revoked_at_ms: null,
  });
  const handlers = createGithubAuthHandlers(dependencies(database));

  const crossOrigin = await handlers.SIGNOUT(new Request('https://example.com/api/auth/github/signout', {
    method: 'POST',
    headers: { cookie: `${GITHUB_SESSION_COOKIE}=${token}`, origin: 'https://evil.example' },
  }));
  assert.equal(crossOrigin.status, 403);
  assert.equal(database.sessions.get(hash)?.revoked_at_ms, null);

  const signedOut = await handlers.SIGNOUT(new Request('https://example.com/api/auth/github/signout', {
    method: 'POST',
    headers: { cookie: `${GITHUB_SESSION_COOKIE}=${token}`, origin: 'https://example.com' },
  }));
  assert.equal(signedOut.status, 200);
  assert.equal(database.sessions.has(hash), false);
  assert.equal(cookieValue(signedOut, GITHUB_SESSION_COOKIE), '');
});

test('malformed cookies are ignored', () => {
  const request = new Request('https://example.com', {
    headers: { cookie: `${GITHUB_SESSION_COOKIE}=%E0%A4%A` },
  });
  assert.equal(requestCookie(request, GITHUB_SESSION_COOKIE), '');
});
