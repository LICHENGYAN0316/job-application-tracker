import { ensureCloudSchemaOnce } from '@/db/schema';
import { readBoundedJson, InvalidJsonBodyError, RequestBodyTooLargeError } from '@/app/lib/bounded-json';
import { agentRuntimeConfig, runAgentQuery } from '@/app/lib/agent-service.server';
import { AuthPrincipalConflictError, resolveAuthPrincipal } from '@/app/lib/auth-principal.server';
import { hasExpectedUserContext } from '@/app/lib/user-scope';
import {
  cloudflareDatabase,
  isSameOriginMutation,
  privateJson,
  runtimeEnvironment,
} from '@/app/lib/server-runtime';

export const dynamic = 'force-dynamic';
const MAX_AGENT_REQUEST_BYTES = 8_000;

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) {
    return privateJson({ error: 'invalid_origin' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await readBoundedJson(request, MAX_AGENT_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return privateJson({ error: 'request_too_large' }, { status: 413 });
    }
    if (error instanceof InvalidJsonBodyError) {
      return privateJson({ error: 'invalid_json' }, { status: 400 });
    }
    return privateJson({ error: 'invalid_json' }, { status: 400 });
  }
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};

  try {
    const database = cloudflareDatabase();
    await ensureCloudSchemaOnce(database);
    const principal = await resolveAuthPrincipal(request, database);
    if (!principal) return privateJson({ error: 'sign_in_required' }, { status: 401 });
    if (!hasExpectedUserContext(request, principal.id)) {
      return privateJson({ error: 'account_context_changed' }, { status: 409 });
    }
    const result = await runAgentQuery({
      database,
      principal,
      config: agentRuntimeConfig(runtimeEnvironment()),
      question: record.question,
      idempotencyKey: record.idempotencyKey,
      sessionId: record.sessionId,
    });
    if (result.ok) return privateJson(result);
    const status = result.code === 'quota_exhausted'
      ? 429
      : result.code === 'invalid_request'
        ? 400
        : result.code === 'technical_failure'
          ? 502
          : 503;
    const headers = new Headers();
    if (result.code === 'quota_exhausted' && result.status?.resetAt) {
      const seconds = Math.max(1, Math.ceil((Date.parse(result.status.resetAt) - Date.now()) / 1_000));
      headers.set('retry-after', String(seconds));
    }
    return privateJson(result, { status, headers });
  } catch (error) {
    if (error instanceof AuthPrincipalConflictError) {
      return privateJson({ error: 'auth_identity_conflict' }, { status: 409 });
    }
    return privateJson({
      ok: false,
      code: 'technical_failure',
      message: '这次没有成功完成分析，但你的求职数据没有受到影响，也不会扣除使用次数。你可以稍后重试，或切换到基础助手继续使用。',
    }, { status: 503 });
  }
}
