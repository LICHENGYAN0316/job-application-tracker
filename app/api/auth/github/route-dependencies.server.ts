import { env } from 'cloudflare:workers';
import { ensureCloudSchemaOnce } from '@/db/schema';
import {
  createGithubAuthHandlers,
  type GithubAuthConfiguration,
  type GithubAuthDatabase,
} from '@/app/lib/github-auth.server';

type GithubRuntimeEnvironment = Cloudflare.Env & {
  DB?: D1Database;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  PUBLIC_APP_ORIGIN?: string;
};

function runtimeEnvironment() {
  return env as GithubRuntimeEnvironment;
}

function database() {
  const binding = runtimeEnvironment().DB;
  if (!binding) throw new Error('Cloud database binding is unavailable.');
  return binding as unknown as GithubAuthDatabase;
}

function configuration(): GithubAuthConfiguration {
  const runtime = runtimeEnvironment();
  return {
    clientId: runtime.GITHUB_CLIENT_ID ?? '',
    clientSecret: runtime.GITHUB_CLIENT_SECRET ?? '',
    publicAppOrigin: runtime.PUBLIC_APP_ORIGIN ?? '',
  };
}

export const githubAuthHandlers = createGithubAuthHandlers({
  database,
  ensureSchema: (authDatabase) => ensureCloudSchemaOnce(authDatabase as unknown as D1Database),
  configuration,
});
