// `zveltio init` in an existing directory: an existing .env holds secrets a running
// install depends on, so it is kept; the .env it writes is readable by its owner only.
// Answers are piped, as a script runs it.
import { afterAll, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '../index.ts');
const root = mkdtempSync(join(tmpdir(), 'zv-cli-init-'));

function init(cwd: string) {
  const r = Bun.spawnSync(['bun', CLI, 'init'], {
    cwd,
    // Loopback port 9 refuses at once: the test never reaches the real registry.
    env: { ...process.env, HOME: root, ZVELTIO_REGISTRY_URL: 'http://127.0.0.1:9' },
    stdin: new TextEncoder().encode('\n'.repeat(20)),
    timeout: 30_000,
  });
  return { code: r.exitCode, out: `${r.stdout}${r.stderr}` };
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

it('writes a new .env with mode 600', () => {
  const dir = join(root, 'fresh');
  mkdirSync(dir);
  expect(init(dir).code).toBe(0);
  expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(dir, '.env'), 'utf8')).toContain('BETTER_AUTH_SECRET=');
}, 40_000);

it('keeps an existing .env and writes the new values beside it', () => {
  const dir = join(root, 'existing');
  mkdirSync(dir);
  writeFileSync(join(dir, '.env'), 'BETTER_AUTH_SECRET=keepme\n');
  const r = init(dir);
  expect(r.code).toBe(0);
  expect(r.out).toContain('Kept the existing .env');
  expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('BETTER_AUTH_SECRET=keepme\n');
  expect(statSync(join(dir, '.env.generated')).mode & 0o777).toBe(0o600);
}, 40_000);
