import { env } from 'cloudflare:workers';
import { ensureCloudSchemaOnce } from '@/db/schema';
import {
  AuthenticationContextConflictError,
  createCloudStateHandlers,
} from '@/app/lib/cloud-state-handlers';
import { AuthPrincipalConflictError, resolveAuthPrincipal } from '@/app/lib/auth-principal.server';
import {
  agentRuntimeConfig,
  ensureAgentUser,
  isAgentAdmin,
  type AgentDatabase,
} from '@/app/lib/agent-service.server';
import {
  expireAgentActionProposals,
  type AgentActionDatabase,
} from '@/app/lib/agent-actions.server';
import type { StateDatabase } from '@/app/lib/cloud-state-service';

export const dynamic = 'force-dynamic';

function database() {
  const binding = (env as Cloudflare.Env & { DB?: D1Database }).DB;
  if (!binding) throw new Error('Cloud database binding is unavailable.');
  return binding;
}

const handlers = createCloudStateHandlers({
  database: () => database() as unknown as StateDatabase,
  ensureSchema: (stateDatabase) => ensureCloudSchemaOnce(stateDatabase as unknown as D1Database),
  authenticate: async (request, stateDatabase) => {
    try {
      const principal = await resolveAuthPrincipal(request, stateDatabase);
      if (principal) {
        const config = agentRuntimeConfig(env as unknown as Record<string, unknown>);
        await ensureAgentUser(
          stateDatabase as unknown as AgentDatabase,
          principal,
          isAgentAdmin(principal, config.adminChatgptUserId),
          Date.now(),
        );
        await expireAgentActionProposals(
          stateDatabase as unknown as AgentActionDatabase,
          principal.id,
        );
      }
      return principal;
    } catch (error) {
      if (error instanceof AuthPrincipalConflictError) throw new AuthenticationContextConflictError();
      throw error;
    }
  },
});

export const GET = handlers.GET;
export const PUT = handlers.PUT;
export const DELETE = handlers.DELETE;
