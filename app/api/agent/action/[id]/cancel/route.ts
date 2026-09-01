import { ensureCloudSchemaOnce } from '@/db/schema';
import {
  cancelAgentAction,
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
      return privateJson({ error: 'request_too_large', message: '取消信息过长，没有修改数据。' }, { status: 413 });
    }
    if (error instanceof InvalidJsonBodyError) {
      return privateJson({ error: 'invalid_json', message: '取消信息格式不正确，没有修改数据。' }, { status: 400 });
    }
    return privateJson({ error: 'invalid_json', message: '取消信息格式不正确，没有修改数据。' }, { status: 400 });
  }
  const record = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  if (Object.keys(record).join(',') !== 'confirmationNonce') {
    return privateJson({ error: 'invalid_request', message: '取消信息不完整，没有修改数据。' }, { status: 400 });
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
    const result = await cancelAgentAction({
      database: database as unknown as AgentActionDatabase,
      principal,
      actionId: id,
      confirmationNonce: record.confirmationNonce,
    });
    if (result.ok) return privateJson(result);
    const status = result.code === 'invalid_request'
      ? 400
      : result.code === 'not_found'
        ? 404
        : result.code === 'invalid_confirmation'
          ? 403
          : 409;
    return privateJson(result, { status });
  } catch (error) {
    if (error instanceof AuthPrincipalConflictError) {
      return privateJson({ error: 'auth_identity_conflict' }, { status: 409 });
    }
    return privateJson({
      error: 'agent_action_unavailable',
      message: '暂时无法取消这次操作，请重新加载页面核对状态。',
    }, { status: 503 });
  }
}
