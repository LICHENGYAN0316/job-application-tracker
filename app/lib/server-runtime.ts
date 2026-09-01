import { env } from 'cloudflare:workers';

export function cloudflareDatabase() {
  const database = (env as Cloudflare.Env & { DB?: D1Database }).DB;
  if (!database) throw new Error('Cloud database binding is unavailable.');
  return database;
}

export function runtimeEnvironment() {
  return env as unknown as Record<string, unknown>;
}

export function privateJson(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('cache-control', 'private, no-store');
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'same-origin');
  return Response.json(body, { ...init, headers });
}

export function isSameOriginMutation(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
