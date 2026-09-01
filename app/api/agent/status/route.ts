import { ensureCloudSchemaOnce } from '@/db/schema';
import { agentRuntimeConfig, getAgentUserStatus } from '@/app/lib/agent-service.server';
import { AuthPrincipalConflictError, resolveAuthPrincipal } from '@/app/lib/auth-principal.server';
import { hasExpectedUserContext } from '@/app/lib/user-scope';
import { cloudflareDatabase, privateJson, runtimeEnvironment } from '@/app/lib/server-runtime';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const database = cloudflareDatabase();
    await ensureCloudSchemaOnce(database);
    const principal = await resolveAuthPrincipal(request, database);
    if (!principal) return privateJson({ error: 'sign_in_required' }, { status: 401 });
    if (!hasExpectedUserContext(request, principal.id)) {
      return privateJson({ error: 'account_context_changed' }, { status: 409 });
    }
    const config = agentRuntimeConfig(runtimeEnvironment());
    return privateJson({
      status: await getAgentUserStatus(database, principal, config),
      provider: principal.provider,
    });
  } catch (error) {
    if (error instanceof AuthPrincipalConflictError) {
      return privateJson({ error: 'auth_identity_conflict' }, { status: 409 });
    }
    return privateJson({ error: 'agent_status_unavailable' }, { status: 503 });
  }
}
