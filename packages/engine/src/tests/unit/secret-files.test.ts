import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSecretFiles } from '../../lib/secret-files.js';

const files = (map: Record<string, string>) => (p: string) => {
  if (!(p in map)) throw new Error('ENOENT');
  return map[p]!;
};

describe('loadSecretFiles', () => {
  it('fills NAME from NAME_FILE and drops one trailing newline', () => {
    const env: Record<string, string | undefined> = { DATABASE_URL_FILE: '/s/db' };
    expect(loadSecretFiles(env, files({ '/s/db': 'postgres://u:p@h/d\n' }))).toEqual([
      'DATABASE_URL',
    ]);
    expect(env.DATABASE_URL).toBe('postgres://u:p@h/d');
  });

  it('refuses NAME and NAME_FILE together', () => {
    const env = { BETTER_AUTH_SECRET: 'a', BETTER_AUTH_SECRET_FILE: '/s/x' };
    expect(() => loadSecretFiles(env, files({ '/s/x': 'b' }))).toThrow(/both set/);
  });

  it('refuses a missing or empty file instead of booting without the secret', () => {
    expect(() => loadSecretFiles({ VALKEY_URL_FILE: '/nope' }, files({}))).toThrow(/cannot read/);
    expect(() => loadSecretFiles({ VALKEY_URL_FILE: '/e' }, files({ '/e': '\n' }))).toThrow(
      /empty/,
    );
  });

  it('ignores *_FILE variables that are not on the secret list', () => {
    const env: Record<string, string | undefined> = { LOG_FILE: '/var/log/x' };
    expect(loadSecretFiles(env, files({}))).toEqual([]);
    expect(env.LOG).toBeUndefined();
  });
});

/**
 * The reason the feature exists: a worker thread can read /proc/self/environ,
 * and a secret passed as a variable stays there even after `delete
 * process.env.X`. Read from a file, it never gets there.
 */
describe.skipIf(process.platform !== 'linux')('a secret from a file', () => {
  it('reaches process.env and not /proc/self/environ', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zv-secret-'));
    const file = join(dir, 'auth');
    writeFileSync(file, 'file-only-secret-7f3a\n');
    const module = join(import.meta.dir, '../../lib/secret-files.ts');
    const proc = Bun.spawn(
      [
        process.execPath,
        '-e',
        `await import(${JSON.stringify(module)});
         const environ = await Bun.file('/proc/self/environ').text();
         console.log(JSON.stringify({ env: process.env.BETTER_AUTH_SECRET, leaked: environ.includes('file-only-secret-7f3a') }));`,
      ],
      { env: { PATH: process.env.PATH ?? '', BETTER_AUTH_SECRET_FILE: file }, stdout: 'pipe' },
    );
    const out = JSON.parse((await new Response(proc.stdout).text()).trim());
    expect(await proc.exited).toBe(0);
    expect(out).toEqual({ env: 'file-only-secret-7f3a', leaked: false });
  });
});
