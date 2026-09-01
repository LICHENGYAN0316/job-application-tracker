import { authenticatedUser } from './user-scope.ts';
import {
  resolveGithubSession,
  type GithubAuthDatabase,
} from './github-auth.server.ts';

export type AuthPrincipal = {
  id: string;
  email: string;
  provider: 'chatgpt' | 'github';
  subject: string;
  displayName: string;
};

export class AuthPrincipalConflictError extends Error {
  constructor() {
    super('More than one independent sign-in identity is active.');
    this.name = 'AuthPrincipalConflictError';
  }
}

export async function resolveAuthPrincipal(
  request: Request,
  database: GithubAuthDatabase,
  options: { now?: number } = {},
): Promise<AuthPrincipal | null> {
  const chatgpt = authenticatedUser(request);
  const github = await resolveGithubSession(request, database, options.now ?? Date.now());

  // ChatGPT and GitHub are intentionally independent identities. Never merge them by email.
  if (chatgpt && github) throw new AuthPrincipalConflictError();
  if (github) return github;
  if (!chatgpt) return null;
  return {
    id: chatgpt.id,
    email: chatgpt.email,
    provider: 'chatgpt',
    subject: chatgpt.id,
    displayName: chatgpt.email || 'ChatGPT 用户',
  };
}
