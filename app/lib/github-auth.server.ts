const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';

export const GITHUB_SESSION_COOKIE = '__Host-zhixu_github_session';
export const GITHUB_OAUTH_STATE_COOKIE = '__Host-zhixu_github_oauth_state';
export const GITHUB_OAUTH_STATE_TTL_MS = 10 * 60 * 1_000;
export const GITHUB_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const GITHUB_PROVIDER_TIMEOUT_MS = 5_000;

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

export type GithubAuthStatement = {
  bind: (...values: unknown[]) => GithubAuthStatement;
  first: <T>() => Promise<T | null>;
  run: () => Promise<{ meta?: { changes?: number } }>;
};

export type GithubAuthDatabase = {
  prepare: (query: string) => GithubAuthStatement;
};

export type GithubAuthConfiguration = {
  clientId: string;
  clientSecret: string;
  publicAppOrigin: string;
};

export type GithubSession = {
  id: string;
  email: '';
  provider: 'github';
  subject: string;
  displayName: string;
};

type GithubOauthStateRow = {
  code_verifier: string;
  redirect_uri: string;
  expires_at_ms: number;
  consumed_at_ms: number | null;
};

type GithubSessionRow = {
  account_key: string;
  github_subject: string;
  display_login: string;
  expires_at_ms: number;
  revoked_at_ms: number | null;
};

type GithubTokenResponse = {
  access_token?: unknown;
  error?: unknown;
};

type GithubUserResponse = {
  id?: unknown;
  login?: unknown;
};

export type GithubAuthDependencies = {
  database: () => GithubAuthDatabase;
  ensureSchema: (database: GithubAuthDatabase) => Promise<void>;
  configuration: () => GithubAuthConfiguration;
  fetch?: typeof fetch;
  providerTimeoutMs?: number;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
};

export class GithubAuthConfigurationError extends Error {
  constructor() {
    super('GitHub authentication is not configured.');
    this.name = 'GithubAuthConfigurationError';
  }
}

function privateHeaders(headers?: HeadersInit) {
  const result = new Headers(headers);
  result.set('cache-control', 'private, no-store');
  result.set('pragma', 'no-cache');
  result.set('x-content-type-options', 'nosniff');
  result.set('referrer-policy', 'no-referrer');
  return result;
}

function privateJson(body: unknown, init: ResponseInit = {}) {
  return Response.json(body, { ...init, headers: privateHeaders(init.headers) });
}

function base64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function defaultRandomBytes(length: number) {
  return crypto.getRandomValues(new Uint8Array(length));
}

async function sha256Bytes(value: string) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

export async function sha256Base64Url(value: string) {
  return base64Url(await sha256Bytes(value));
}

function parseCookies(request: Request) {
  const cookies = new Map<string, string>();
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name || cookies.has(name)) continue;
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      // Ignore malformed cookie values rather than accepting a partially decoded token.
    }
  }
  return cookies;
}

export function requestCookie(request: Request, name: string) {
  return parseCookies(request).get(name) ?? '';
}

function secureCookie(name: string, value: string, maxAgeSeconds: number) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}

export function clearCookie(name: string) {
  return secureCookie(name, '', 0);
}

function normalizedOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GithubAuthConfigurationError();
  }

  const isLocalHttp = url.protocol === 'http:'
    && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  if (url.protocol !== 'https:' && !isLocalHttp) throw new GithubAuthConfigurationError();
  if (url.username || url.password || url.search || url.hash) throw new GithubAuthConfigurationError();
  if (url.pathname !== '/' && url.pathname !== '') throw new GithubAuthConfigurationError();
  return url.origin;
}

export function validatedGithubConfiguration(configuration: GithubAuthConfiguration) {
  const clientId = configuration.clientId.trim();
  const clientSecret = configuration.clientSecret.trim();
  if (!clientId || !clientSecret || clientId.length > 500 || clientSecret.length > 2_000) {
    throw new GithubAuthConfigurationError();
  }
  return {
    clientId,
    clientSecret,
    publicAppOrigin: normalizedOrigin(configuration.publicAppOrigin.trim()),
  };
}

export function githubCallbackUrl(configuration: GithubAuthConfiguration) {
  return `${validatedGithubConfiguration(configuration).publicAppOrigin}/api/auth/github/callback`;
}

function safeRedirect(configuration: GithubAuthConfiguration, status: 'success' | 'failed') {
  const { publicAppOrigin } = validatedGithubConfiguration(configuration);
  const url = new URL('/', publicAppOrigin);
  url.searchParams.set('github_auth', status);
  return url.toString();
}

function redirect(location: string, cookies: string[] = []) {
  const headers = privateHeaders({ location });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 303, headers });
}

function validOpaqueToken(value: string) {
  return value.length >= 32 && value.length <= 512 && /^[A-Za-z0-9_-]+$/.test(value);
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function validGithubSubject(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function normalizedLogin(value: unknown) {
  if (typeof value !== 'string') return '';
  const login = value.trim();
  return login.length > 0 && login.length <= 100 && /^[A-Za-z0-9-]+$/.test(login) ? login : '';
}

function requestOriginMatches(request: Request, expectedOrigin: string) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).origin === expectedOrigin;
  } catch {
    return false;
  }
}

async function fetchWithTimeout(
  requestFetch: typeof fetch,
  input: URL | RequestInfo,
  init: RequestInit,
  timeoutMs: number,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await requestFetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function bestEffortCleanupGithubAuthRecords(database: GithubAuthDatabase, timestamp: number) {
  const cleanupQueries = [
    `
      DELETE FROM github_oauth_states
      WHERE expires_at_ms <= ? OR consumed_at_ms IS NOT NULL
    `,
    `
      DELETE FROM github_sessions
      WHERE expires_at_ms <= ? OR revoked_at_ms IS NOT NULL
    `,
  ];

  for (const query of cleanupQueries) {
    try {
      await database.prepare(query).bind(timestamp).run();
    } catch {
      // Cleanup is opportunistic. A transient D1 failure must not block authentication.
    }
  }
}

async function resolveSessionToken(
  database: GithubAuthDatabase,
  token: string,
  now: number,
): Promise<GithubSession | null> {
  if (!validOpaqueToken(token)) return null;
  const sessionHash = await sha256Base64Url(token);
  const row = await database.prepare(`
    SELECT account_key, github_subject, display_login, expires_at_ms, revoked_at_ms
    FROM github_sessions
    WHERE session_hash = ?
    LIMIT 1
  `).bind(sessionHash).first<GithubSessionRow>();
  if (!row || row.revoked_at_ms !== null || Number(row.expires_at_ms) <= now) return null;
  const subject = String(row.github_subject);
  if (row.account_key !== `github:${subject}` || !/^\d+$/.test(subject)) return null;
  return {
    id: row.account_key,
    email: '',
    provider: 'github',
    subject,
    displayName: normalizedLogin(row.display_login) || `GitHub ${subject}`,
  };
}

export async function resolveGithubSession(
  request: Request,
  database: GithubAuthDatabase,
  now = Date.now(),
) {
  return resolveSessionToken(database, requestCookie(request, GITHUB_SESSION_COOKIE), now);
}

export function createGithubAuthHandlers(dependencies: GithubAuthDependencies) {
  const now = dependencies.now ?? Date.now;
  const randomBytes = dependencies.randomBytes ?? defaultRandomBytes;
  const requestFetch = dependencies.fetch ?? fetch;
  const providerTimeoutMs = Math.max(1, dependencies.providerTimeoutMs ?? GITHUB_PROVIDER_TIMEOUT_MS);

  const START = async () => {
    try {
      const configuration = validatedGithubConfiguration(dependencies.configuration());
      const database = dependencies.database();
      await dependencies.ensureSchema(database);
      await bestEffortCleanupGithubAuthRecords(database, now());

      const state = base64Url(randomBytes(32));
      const verifier = base64Url(randomBytes(64));
      if (!validOpaqueToken(state) || !validOpaqueToken(verifier)) {
        throw new Error('Secure random token generation failed.');
      }
      const stateHash = await sha256Base64Url(state);
      const challenge = await sha256Base64Url(verifier);
      const redirectUri = `${configuration.publicAppOrigin}/api/auth/github/callback`;
      const createdAt = now();
      await database.prepare(`
        INSERT INTO github_oauth_states (
          state_hash, code_verifier, redirect_uri, created_at_ms, expires_at_ms, consumed_at_ms
        ) VALUES (?, ?, ?, ?, ?, NULL)
      `).bind(
        stateHash,
        verifier,
        redirectUri,
        createdAt,
        createdAt + GITHUB_OAUTH_STATE_TTL_MS,
      ).run();

      const authorizationUrl = new URL(GITHUB_AUTHORIZE_URL);
      authorizationUrl.searchParams.set('client_id', configuration.clientId);
      authorizationUrl.searchParams.set('redirect_uri', redirectUri);
      authorizationUrl.searchParams.set('state', state);
      authorizationUrl.searchParams.set('code_challenge', challenge);
      authorizationUrl.searchParams.set('code_challenge_method', 'S256');
      // Deliberately omit scope: GitHub then grants identity-only public profile access, never repo access.
      return redirect(authorizationUrl.toString(), [
        secureCookie(GITHUB_OAUTH_STATE_COOKIE, state, GITHUB_OAUTH_STATE_TTL_MS / 1_000),
      ]);
    } catch {
      return privateJson({ error: 'github_auth_unavailable' }, { status: 503 });
    }
  };

  const CALLBACK = async (request: Request) => {
    let configuration: ReturnType<typeof validatedGithubConfiguration>;
    try {
      configuration = validatedGithubConfiguration(dependencies.configuration());
    } catch {
      return privateJson({ error: 'github_auth_unavailable' }, { status: 503 });
    }
    const failed = () => redirect(safeRedirect(configuration, 'failed'), [
      clearCookie(GITHUB_OAUTH_STATE_COOKIE),
    ]);

    try {
      const requestUrl = new URL(request.url);
      if (requestUrl.origin !== configuration.publicAppOrigin) return failed();
      const code = requestUrl.searchParams.get('code') ?? '';
      const returnedState = requestUrl.searchParams.get('state') ?? '';
      const cookieState = requestCookie(request, GITHUB_OAUTH_STATE_COOKIE);
      if (
        code.length < 1
        || code.length > 2_000
        || !validOpaqueToken(returnedState)
        || !validOpaqueToken(cookieState)
        || !constantTimeEqual(returnedState, cookieState)
      ) return failed();

      const database = dependencies.database();
      await dependencies.ensureSchema(database);
      await bestEffortCleanupGithubAuthRecords(database, now());
      const stateHash = await sha256Base64Url(returnedState);
      const stateRow = await database.prepare(`
        SELECT code_verifier, redirect_uri, expires_at_ms, consumed_at_ms
        FROM github_oauth_states
        WHERE state_hash = ?
        LIMIT 1
      `).bind(stateHash).first<GithubOauthStateRow>();
      const callbackUrl = `${configuration.publicAppOrigin}/api/auth/github/callback`;
      const consumedAt = now();
      if (
        !stateRow
        || stateRow.consumed_at_ms !== null
        || Number(stateRow.expires_at_ms) <= consumedAt
        || stateRow.redirect_uri !== callbackUrl
        || !validOpaqueToken(stateRow.code_verifier)
      ) return failed();

      const consumed = await database.prepare(`
        UPDATE github_oauth_states
        SET consumed_at_ms = ?
        WHERE state_hash = ? AND consumed_at_ms IS NULL AND expires_at_ms > ?
      `).bind(consumedAt, stateHash, consumedAt).run();
      if (Number(consumed.meta?.changes ?? 0) !== 1) return failed();

      const tokenResponse = await fetchWithTimeout(requestFetch, GITHUB_TOKEN_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'Zhixu-Career-Pipeline',
        },
        body: new URLSearchParams({
          client_id: configuration.clientId,
          client_secret: configuration.clientSecret,
          code,
          redirect_uri: callbackUrl,
          code_verifier: stateRow.code_verifier,
        }),
      }, providerTimeoutMs);
      if (!tokenResponse.ok) return failed();
      const tokenPayload = await tokenResponse.json() as GithubTokenResponse;
      const accessToken = typeof tokenPayload.access_token === 'string'
        ? tokenPayload.access_token.trim()
        : '';
      if (!accessToken || accessToken.length > 2_000 || tokenPayload.error) return failed();

      const userResponse = await fetchWithTimeout(requestFetch, GITHUB_USER_URL, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${accessToken}`,
          'user-agent': 'Zhixu-Career-Pipeline',
          'x-github-api-version': '2022-11-28',
        },
      }, providerTimeoutMs);
      if (!userResponse.ok) return failed();
      const userPayload = await userResponse.json() as GithubUserResponse;
      if (!validGithubSubject(userPayload.id)) return failed();
      const login = normalizedLogin(userPayload.login);
      if (!login) return failed();

      const subject = String(userPayload.id);
      const accountKey = `github:${subject}`;
      const sessionToken = base64Url(randomBytes(32));
      if (!validOpaqueToken(sessionToken)) throw new Error('Secure session token generation failed.');
      const sessionHash = await sha256Base64Url(sessionToken);
      const createdAt = now();
      await database.prepare(`
        INSERT INTO github_sessions (
          session_hash, account_key, github_subject, display_login,
          created_at_ms, expires_at_ms, revoked_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, NULL)
      `).bind(
        sessionHash,
        accountKey,
        subject,
        login,
        createdAt,
        createdAt + GITHUB_SESSION_TTL_MS,
      ).run();

      // The provider access token is intentionally not persisted. It becomes unreachable after this request.
      return redirect(safeRedirect(configuration, 'success'), [
        clearCookie(GITHUB_OAUTH_STATE_COOKIE),
        secureCookie(GITHUB_SESSION_COOKIE, sessionToken, GITHUB_SESSION_TTL_MS / 1_000),
      ]);
    } catch {
      return failed();
    }
  };

  const SESSION = async (request: Request) => {
    try {
      const database = dependencies.database();
      await dependencies.ensureSchema(database);
      await bestEffortCleanupGithubAuthRecords(database, now());
      const session = await resolveGithubSession(request, database, now());
      if (!session) {
        const headers = privateHeaders();
        headers.append('set-cookie', clearCookie(GITHUB_SESSION_COOKIE));
        return Response.json({ authenticated: false }, { headers });
      }
      return privateJson({
        authenticated: true,
        provider: session.provider,
        accountKey: session.id,
        subject: session.subject,
        displayLogin: session.displayName,
      });
    } catch {
      return privateJson({ error: 'github_session_unavailable' }, { status: 503 });
    }
  };

  const SIGNOUT = async (request: Request) => {
    const signedOutResponse = (body: unknown, status: number) => {
      const headers = privateHeaders();
      headers.set('x-zhixu-device-session-cleared', '1');
      headers.append('set-cookie', clearCookie(GITHUB_SESSION_COOKIE));
      headers.append('set-cookie', clearCookie(GITHUB_OAUTH_STATE_COOKIE));
      return Response.json(body, { status, headers });
    };
    let configuration: ReturnType<typeof validatedGithubConfiguration>;
    try {
      configuration = validatedGithubConfiguration(dependencies.configuration());
    } catch {
      if (!requestOriginMatches(request, new URL(request.url).origin)) {
        return privateJson({ error: 'invalid_request_origin' }, { status: 403 });
      }
      return signedOutResponse({ error: 'github_auth_unavailable' }, 503);
    }
    if (!requestOriginMatches(request, configuration.publicAppOrigin)) {
      return privateJson({ error: 'invalid_request_origin' }, { status: 403 });
    }

    try {
      const database = dependencies.database();
      await dependencies.ensureSchema(database);
      const token = requestCookie(request, GITHUB_SESSION_COOKIE);
      if (validOpaqueToken(token)) {
        await database.prepare(`
          UPDATE github_sessions
          SET revoked_at_ms = ?
          WHERE session_hash = ? AND revoked_at_ms IS NULL
        `).bind(now(), await sha256Base64Url(token)).run();
      }
      await bestEffortCleanupGithubAuthRecords(database, now());
      return signedOutResponse({ ok: true }, 200);
    } catch {
      return signedOutResponse({ error: 'github_signout_unavailable' }, 503);
    }
  };

  return { START, CALLBACK, SESSION, SIGNOUT };
}
