import { ensureCloudSchemaOnce } from '@/db/schema';
import {
  recordAgentActionFeedback,
  type AgentActionDatabase,
} from '@/app/lib/agent-actions.server';
import { AuthPrincipalConflictError, resolveAuthPrincipal } from '@/app/lib/auth-principal.server';
import { InvalidJsonBodyError, readBoundedJson, RequestBodyTooLargeError } from '@/app/lib/bounded-json';
import { cloudflareDatabase, isSameOriginMutation, privateJson } from '@/app/lib/server-runtime';
import { hasExpectedUserContext } from '@/app/lib/user-scope';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginMutation(request)) return privateJson({ error: 'invalid_origin' }, { status: 403 });
  let body: unknown;
  try {
    body = await readBoundedJson(request, 1_000);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return privateJson({ error: 'request_too_large' }, { status: 413 });
    }
    if (error instanceof InvalidJsonBodyError) return privateJson({ error: 'invalid_json' }, { status: 400 });
    return privateJson({ error: 'invalid_json' }, { status: 400 });
  }
  const record = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  if (Object.keys(record).join(',') !== 'outcome') {
    return privateJson({ error: 'invalid_request' }, { status: 400 });
  }
  try {
    const database = cloudflareDatabase();
    await ensureCloudSchemaOnce(database);
    const principal = await resolveAuthPrincipal(request, database);
    if (!principal) return privateJson({ error: 'sign_in_required' }, { status: 401 });
    if (!hasExpectedUserContext(request, principal.id)) {
      return privateJson({ error: 'account_context_changed' }, { status: 409 });
    }
    const { id } = await context.params;
    const saved = await recordAgentActionFeedback({
      database: database as unknown as AgentActionDatabase,
      principal,
      actionId: id,
      outcome: record.outcome,
    });
    return saved
      ? privateJson({ ok: true })
      : privateJson({ error: 'feedback_not_saved', message: '这次评价没有保存，可能已评价过，或提案尚未取消或执行。' }, { status: 409 });
  } catch (error) {
    if (error instanceof AuthPrincipalConflictError) {
      return privateJson({ error: 'auth_identity_conflict' }, { status: 409 });
    }
    return privateJson({ error: 'feedback_unavailable', message: '评价暂时无法保存，不影响已完成的操作。' }, { status: 503 });
  }
}
