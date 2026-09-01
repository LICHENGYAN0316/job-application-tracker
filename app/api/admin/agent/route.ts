import { ensureCloudSchemaOnce } from '@/db/schema';
import { readBoundedJson, InvalidJsonBodyError, RequestBodyTooLargeError } from '@/app/lib/bounded-json';
import {
  AgentAdminForbiddenError,
  AgentAdminInvalidLimitError,
  AgentAdminProtectedAccountError,
  AgentAdminTargetNotFoundError,
  isAgentDailyLimit,
  readAgentAdminDashboard,
  setAgentDefaultLimit,
  setAgentGlobalEnabled,
  setAgentUserDisabled,
  setAgentUserLimit,
} from '@/app/lib/agent-admin.server';
import { agentRuntimeConfig } from '@/app/lib/agent-service.server';
import { AuthPrincipalConflictError, resolveAuthPrincipal } from '@/app/lib/auth-principal.server';
import { hasExpectedUserContext } from '@/app/lib/user-scope';
import {
  cloudflareDatabase,
  isSameOriginMutation,
  privateJson,
  runtimeEnvironment,
} from '@/app/lib/server-runtime';

export const dynamic = 'force-dynamic';

function errorResponse(error: unknown) {
  if (error instanceof AuthPrincipalConflictError) {
    return privateJson({ error: 'auth_identity_conflict' }, { status: 409 });
  }
  if (error instanceof AgentAdminForbiddenError) {
    return privateJson({ error: 'admin_required' }, { status: 403 });
  }
  if (error instanceof AgentAdminInvalidLimitError) {
    return privateJson({ error: 'invalid_limit' }, { status: 400 });
  }
  if (error instanceof AgentAdminTargetNotFoundError) {
    return privateJson({ error: 'user_not_found' }, { status: 404 });
  }
  if (error instanceof AgentAdminProtectedAccountError) {
    return privateJson({ error: 'admin_account_protected' }, { status: 409 });
  }
  return privateJson({ error: 'admin_panel_unavailable' }, { status: 503 });
}

export async function GET(request: Request) {
  try {
    const database = cloudflareDatabase();
    await ensureCloudSchemaOnce(database);
    const environment = runtimeEnvironment();
    const principal = await resolveAuthPrincipal(request, database);
    if (!principal) return privateJson({ error: 'sign_in_required' }, { status: 401 });
    if (!hasExpectedUserContext(request, principal.id)) {
      return privateJson({ error: 'account_context_changed' }, { status: 409 });
    }
    return privateJson(await readAgentAdminDashboard(
      database,
      principal,
      agentRuntimeConfig(environment),
    ));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  if (!isSameOriginMutation(request)) {
    return privateJson({ error: 'invalid_origin' }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await readBoundedJson(request, 4_000);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return privateJson({ error: 'request_too_large' }, { status: 413 });
    }
    if (error instanceof InvalidJsonBodyError) {
      return privateJson({ error: 'invalid_json' }, { status: 400 });
    }
    return privateJson({ error: 'invalid_json' }, { status: 400 });
  }

  try {
    const database = cloudflareDatabase();
    await ensureCloudSchemaOnce(database);
    const environment = runtimeEnvironment();
    const principal = await resolveAuthPrincipal(request, database);
    if (!principal) return privateJson({ error: 'sign_in_required' }, { status: 401 });
    if (!hasExpectedUserContext(request, principal.id)) {
      return privateJson({ error: 'account_context_changed' }, { status: 409 });
    }
    const config = agentRuntimeConfig(environment);
    const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    if (record.kind === 'global' && typeof record.enabled === 'boolean') {
      await setAgentGlobalEnabled(database, principal, config, record.enabled);
    } else if (record.kind === 'default_limit' && isAgentDailyLimit(record.limit)) {
      await setAgentDefaultLimit(database, principal, config, record.limit);
    } else if (
      record.kind === 'user'
      && typeof record.userNumber === 'number'
      && Number.isSafeInteger(record.userNumber)
      && record.userNumber > 0
      && typeof record.disabled === 'boolean'
    ) {
      await setAgentUserDisabled(database, principal, config, record.userNumber, record.disabled);
    } else if (
      record.kind === 'user_limit'
      && typeof record.userNumber === 'number'
      && Number.isSafeInteger(record.userNumber)
      && record.userNumber > 0
      && (record.limit === null || isAgentDailyLimit(record.limit))
    ) {
      await setAgentUserLimit(database, principal, config, record.userNumber, record.limit);
    } else {
      return privateJson({ error: 'invalid_request' }, { status: 400 });
    }
    return privateJson({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
