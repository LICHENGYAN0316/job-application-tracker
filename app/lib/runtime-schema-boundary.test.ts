import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [path] : [];
  }));
  return nested.flat();
}

test('deployed request handlers never run schema creation or migration SQL', async () => {
  const requestFiles = [
    ...await typescriptFiles(join(projectRoot, 'app', 'api')),
    join(projectRoot, 'app', 'lib', 'cloud-state-handlers.ts'),
    join(projectRoot, 'app', 'lib', 'github-auth.server.ts'),
  ];
  const forbidden = [
    /ensureCloudSchema/,
    /\b(?:CREATE|ALTER|DROP)\s+TABLE\b/i,
    /\bPRAGMA\s+table_info\b/i,
    /\bsqlite_master\b/i,
  ];

  for (const path of requestFiles) {
    const source = await readFile(path, 'utf8');
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${path} must rely on deployment migrations`);
    }
  }
});
