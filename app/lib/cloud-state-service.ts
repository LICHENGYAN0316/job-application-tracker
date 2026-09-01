import type { AuthenticatedUser } from './user-scope.ts';

export const NO_STATE_VERSION = 'none';
export const LEGACY_STATE_VERSION = 'legacy';

export type StateRow = {
  data_json: string;
  updated_at: string;
  version: string;
  deleted_at: string | null;
};

export type StateStatement = {
  bind: (...values: unknown[]) => StateStatement;
  first: <T>() => Promise<T | null>;
  run: () => Promise<{ meta?: { changes?: number } }>;
};

export type StateDatabase = {
  prepare: (query: string) => StateStatement;
};

export type WriteDependencies = {
  now?: () => string;
  randomId?: () => string;
};

export async function readUserState(database: StateDatabase, user: AuthenticatedUser) {
  const row = await database
    .prepare('SELECT data_json, updated_at, version, deleted_at FROM application_states WHERE user_id = ?')
    .bind(user.id)
    .first<StateRow>();

  if (!row) {
    return {
      state: null,
      updatedAt: null,
      version: NO_STATE_VERSION,
      user,
    };
  }

  const version = row.version || LEGACY_STATE_VERSION;
  if (row.deleted_at) {
    return { state: null, updatedAt: row.updated_at, version, user };
  }

  try {
    return {
      state: JSON.parse(row.data_json) as unknown,
      updatedAt: row.updated_at,
      version,
      user,
    };
  } catch (error) {
    throw new StoredCloudStateInvalidError(error);
  }
}

export async function writeUserState(
  database: StateDatabase,
  user: AuthenticatedUser,
  baseVersion: string,
  serializedState: string,
  dependencies: WriteDependencies = {},
) {
  const updatedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  const nextVersion = (dependencies.randomId ?? (() => crypto.randomUUID()))();
  const result = baseVersion === NO_STATE_VERSION
    ? await database
      .prepare(`
        INSERT OR IGNORE INTO application_states
          (user_id, user_email, data_json, updated_at, version, deleted_at)
        VALUES (?, ?, ?, ?, ?, NULL)
      `)
      .bind(user.id, user.email, serializedState, updatedAt, nextVersion)
      .run()
    : await database
      .prepare(`
        UPDATE application_states
        SET user_email = ?, data_json = ?, updated_at = ?, version = ?, deleted_at = NULL
        WHERE user_id = ? AND version = ?
      `)
      .bind(user.email, serializedState, updatedAt, nextVersion, user.id, baseVersion)
      .run();

  if ((result.meta?.changes ?? 0) !== 1) throw new CloudStateVersionConflictError();
  return { ok: true as const, updatedAt, version: nextVersion };
}

export async function deleteUserState(
  database: StateDatabase,
  user: AuthenticatedUser,
  baseVersion: string,
  dependencies: WriteDependencies = {},
) {
  const updatedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  const nextVersion = (dependencies.randomId ?? (() => crypto.randomUUID()))();
  const emptyState = JSON.stringify({ companies: [] });
  const result = baseVersion === NO_STATE_VERSION
    ? await database
      .prepare(`
        INSERT OR IGNORE INTO application_states
          (user_id, user_email, data_json, updated_at, version, deleted_at)
        VALUES (?, '', ?, ?, ?, ?)
      `)
      .bind(user.id, emptyState, updatedAt, nextVersion, updatedAt)
      .run()
    : await database
      .prepare(`
        UPDATE application_states
        SET user_email = '', data_json = ?, updated_at = ?, version = ?, deleted_at = ?
        WHERE user_id = ? AND version = ?
      `)
      .bind(emptyState, updatedAt, nextVersion, updatedAt, user.id, baseVersion)
      .run();

  if ((result.meta?.changes ?? 0) !== 1) throw new CloudStateVersionConflictError();
  return { ok: true as const, updatedAt, version: nextVersion };
}

export class CloudStateVersionConflictError extends Error {
  constructor() {
    super('Cloud state version conflict.');
    this.name = 'CloudStateVersionConflictError';
  }
}

export class StoredCloudStateInvalidError extends Error {
  constructor(cause?: unknown) {
    super('Stored cloud state is invalid.', cause instanceof Error ? { cause } : undefined);
    this.name = 'StoredCloudStateInvalidError';
  }
}
