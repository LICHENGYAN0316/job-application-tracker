import { STAGES } from './domain.ts';
import {
  InvalidJsonBodyError,
  readBoundedJson,
  RequestBodyTooLargeError,
} from './bounded-json.ts';
import {
  CloudStateVersionConflictError,
  deleteUserState,
  LEGACY_STATE_VERSION,
  readUserState,
  type StateDatabase,
  StoredCloudStateInvalidError,
  writeUserState,
  type WriteDependencies,
} from './cloud-state-service.ts';
import { authenticatedUser, hasExpectedUserContext, type AuthenticatedUser } from './user-scope.ts';

export const MAX_STATE_BYTES = 2_000_000;
const ALLOWED_STAGES = new Set<string>(STAGES);

export type StateHandlerDependencies = WriteDependencies & {
  database: () => StateDatabase;
  ensureSchema: (database: StateDatabase) => Promise<void>;
  authenticate?: (request: Request, database: StateDatabase) => Promise<AuthenticatedUser | null>;
};

function privateJson(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('cache-control', 'private, no-store');
  headers.set('x-content-type-options', 'nosniff');
  return Response.json(body, { ...init, headers });
}

function requestedBaseVersion(request: Request) {
  const value = request.headers.get('x-state-base-version');
  if (!value || value.length > 200) return null;
  return value === LEGACY_STATE_VERSION ? '' : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidState(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.companies) || value.companies.length > 500) {
    return false;
  }

  return value.companies.every((company) => {
    if (!isRecord(company) || typeof company.id !== 'string' || typeof company.name !== 'string') {
      return false;
    }
    if (!Array.isArray(company.jobs) || company.jobs.length > 500) return false;
    return company.jobs.every((job) => {
      if (!isRecord(job) || typeof job.id !== 'string' || typeof job.title !== 'string') return false;
      if (typeof job.stage !== 'string' || !ALLOWED_STAGES.has(job.stage)) return false;
      if (!Array.isArray(job.process) || job.process.length > 1_000) return false;
      return job.process.every((item) => (
        isRecord(item)
        && typeof item.id === 'string'
        && typeof item.stage === 'string'
        && ALLOWED_STAGES.has(item.stage)
      ));
    });
  });
}

function stateConflict() {
  return privateJson({ error: 'state_version_conflict' }, { status: 409 });
}

function accountContextChanged() {
  return privateJson({ error: 'account_context_changed' }, { status: 409 });
}

function handleServiceError(error: unknown) {
  if (error instanceof CloudStateVersionConflictError) return stateConflict();
  if (error instanceof StoredCloudStateInvalidError) {
    return privateJson({ error: 'stored_state_invalid' }, { status: 500 });
  }
  return privateJson({ error: 'cloud_state_unavailable' }, { status: 500 });
}

export function createCloudStateHandlers(dependencies: StateHandlerDependencies) {
  const GET = async (request: Request) => {
    try {
      const database = dependencies.database();
      await dependencies.ensureSchema(database);
      const user = dependencies.authenticate
        ? await dependencies.authenticate(request, database)
        : authenticatedUser(request);
      if (!user) return privateJson({ error: 'sign_in_required' }, { status: 401 });
      return privateJson(await readUserState(database, user));
    } catch (error) {
      if (error instanceof AuthenticationContextConflictError) return accountContextChanged();
      return handleServiceError(error);
    }
  };

  const PUT = async (request: Request) => {
    const database = dependencies.database();
    let user: AuthenticatedUser | null;
    try {
      await dependencies.ensureSchema(database);
      user = dependencies.authenticate
        ? await dependencies.authenticate(request, database)
        : authenticatedUser(request);
    } catch (error) {
      if (error instanceof AuthenticationContextConflictError) return accountContextChanged();
      return handleServiceError(error);
    }
    if (!user) return privateJson({ error: 'sign_in_required' }, { status: 401 });
    if (!hasExpectedUserContext(request, user.id)) return accountContextChanged();

    const baseVersion = requestedBaseVersion(request);
    if (baseVersion === null) return stateConflict();

    let state: unknown;
    try {
      state = await readBoundedJson(request, MAX_STATE_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return privateJson({ error: 'state_too_large' }, { status: 413 });
      }
      if (error instanceof InvalidJsonBodyError) {
        return privateJson({ error: 'invalid_json' }, { status: 400 });
      }
      return privateJson({ error: 'invalid_json' }, { status: 400 });
    }

    if (!isValidState(state)) return privateJson({ error: 'invalid_state' }, { status: 400 });
    const serialized = JSON.stringify(state);
    if (new TextEncoder().encode(serialized).byteLength > MAX_STATE_BYTES) {
      return privateJson({ error: 'state_too_large' }, { status: 413 });
    }

    try {
      return privateJson(await writeUserState(database, user, baseVersion, serialized, dependencies));
    } catch (error) {
      return handleServiceError(error);
    }
  };

  const DELETE = async (request: Request) => {
    const database = dependencies.database();
    let user: AuthenticatedUser | null;
    try {
      await dependencies.ensureSchema(database);
      user = dependencies.authenticate
        ? await dependencies.authenticate(request, database)
        : authenticatedUser(request);
    } catch (error) {
      if (error instanceof AuthenticationContextConflictError) return accountContextChanged();
      return handleServiceError(error);
    }
    if (!user) return privateJson({ error: 'sign_in_required' }, { status: 401 });
    if (!hasExpectedUserContext(request, user.id)) return accountContextChanged();

    const baseVersion = requestedBaseVersion(request);
    if (baseVersion === null) return stateConflict();

    try {
      return privateJson(await deleteUserState(database, user, baseVersion, dependencies));
    } catch (error) {
      return handleServiceError(error);
    }
  };

  return { GET, PUT, DELETE };
}

export class AuthenticationContextConflictError extends Error {}
