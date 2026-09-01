const USER_STORAGE_KEY_PREFIX = 'career-pipeline-user-state-v2';
export const MAX_AUTHENTICATED_USER_ID_LENGTH = 200;
export const MAX_AUTHENTICATED_EMAIL_LENGTH = 320;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

export type AuthenticatedUser = {
  id: string;
  email: string;
};

export function isValidAuthenticatedUserId(value: string) {
  return value.length > 0
    && value.length <= MAX_AUTHENTICATED_USER_ID_LENGTH
    && !CONTROL_CHARACTERS.test(value);
}

function normalizedEmail(value: string | null) {
  const email = value?.trim() ?? '';
  if (email.length > MAX_AUTHENTICATED_EMAIL_LENGTH || CONTROL_CHARACTERS.test(email)) return '';
  return email;
}

export function authenticatedUser(request: Request): AuthenticatedUser | null {
  const id = request.headers.get('oai-authenticated-user-id')?.trim();
  if (!id || !isValidAuthenticatedUserId(id)) return null;
  return {
    id,
    email: normalizedEmail(request.headers.get('oai-authenticated-user-email')),
  };
}

export function hasExpectedUserContext(request: Request, authenticatedUserId: string) {
  const expectedUserId = request.headers.get('x-expected-user-id')?.trim() ?? '';
  return isValidAuthenticatedUserId(expectedUserId) && expectedUserId === authenticatedUserId;
}

export function storageKeyForUser(userId: string) {
  const normalized = userId.trim();
  if (!isValidAuthenticatedUserId(normalized)) throw new Error('Authenticated user ID is invalid.');
  return `${USER_STORAGE_KEY_PREFIX}:${encodeURIComponent(normalized)}`;
}

export function isUserStorageKey(value: string) {
  return value.startsWith(`${USER_STORAGE_KEY_PREFIX}:`);
}
