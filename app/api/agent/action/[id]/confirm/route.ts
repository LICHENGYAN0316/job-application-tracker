import { ensureCloudSchemaOnce } from '@/db/schema';
import {
  confirmAgentAction,
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
    body = await readBoundedJson(request, 2_000);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return privateJson({ error: 'request_too_large', message: '确认信息过长，本次没有修改数据。' }, { status: 413 });
    }
    if (error instanceof InvalidJsonBodyError) {
      return privateJson({ error: 'invalid_json', message: '确认信息格式不正确，本次没有修改数据。' }, { status: 400 });
    }
    return privateJson({ error: 'invalid_json', message: '确认信息格式不正确，本次没有修改数据。' }, { status: 400 });
  }
  const record = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  if (Object.keys(record).sort().join(',') !== 'confirmationNonce,requestId') {
    return privateJson({ error: 'invalid_request', message: '确认信息不完整，本次没有修改数据。' }, { status: 400 });
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
    const result = await confirmAgentAction({
      database: database as unknown as AgentActionDatabase,
      principal,
      actionId: id,
      confirmationNonce: record.confirmationNonce,
      requestId: record.requestId,
    });
    if (result.ok) return privateJson(result);
    const status = result.code === 'invalid_request'
      ? 400
      : result.code === 'not_found'
        ? 404
        : result.code === 'invalid_confirmation'
          ? 403
          : result.code === 'failed'
            ? 503
            : 409;
    const headers = result.code === 'in_progress' ? { 'retry-after': '2' } : undefined;
    return privateJson(result, { status, headers });
  } catch (error) {
    if (error instanceof AuthPrincipalConflictError) {
      return privateJson({ error: 'auth_identity_conflict' }, { status: 409 });
    }
    return privateJson({
      error: 'agent_action_unavailable',
      message: '暂时无法确认本次操作的最终状态，请重新加载页面核对，系统不会误报成功。',
    }, { status: 503 });
  }
}
