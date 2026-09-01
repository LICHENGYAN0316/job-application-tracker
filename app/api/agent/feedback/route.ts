import { ensureCloudSchemaOnce } from '@/db/schema';
import { readBoundedJson, InvalidJsonBodyError, RequestBodyTooLargeError } from '@/app/lib/bounded-json';
import { recordAgentFeedback } from '@/app/lib/agent-service.server';
import { AuthPrincipalConflictError, resolveAuthPrincipal } from '@/app/lib/auth-principal.server';
import { hasExpectedUserContext } from '@/app/lib/user-scope';
import {
  cloudflareDatabase,
  isSameOriginMutation,
  privateJson,
} from '@/app/lib/server-runtime';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) {
    return privateJson({ error: 'invalid_origin' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await readBoundedJson(request, 2_000);
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
    const principal = await resolveAuthPrincipal(request, database);
    if (!principal) return privateJson({ error: 'sign_in_required' }, { status: 401 });
    if (!hasExpectedUserContext(request, principal.id)) {
      return privateJson({ error: 'account_context_changed' }, { status: 409 });
    }
    const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const saved = await recordAgentFeedback(
      database,
      principal,
      record.callId,
      record.outcome,
    );
    return saved
      ? privateJson({ ok: true })
      : privateJson({ error: 'feedback_not_saved' }, { status: 409 });
  } catch (error) {
    if (error instanceof AuthPrincipalConflictError) {
      return privateJson({ error: 'auth_identity_conflict' }, { status: 409 });
    }
    return privateJson({ error: 'feedback_unavailable' }, { status: 503 });
  }
}
