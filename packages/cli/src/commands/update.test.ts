/**
 * There has never been a stable 3.x release, so the live versions.json carries
 * `"latest": null`. `update` required that field and failed every run — even
 * `--channel beta` — as "Invalid versions response".
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const server = Bun.serve({
  port: 0,
  fetch: () => Response.json({ latest: null, latest_beta: '99.0.0-beta.1', versions: [] }),
});
afterAll(() => server.stop(true));

// Async spawn: a synchronous one blocks this process, and the fake registry
// above lives in it. The install meta pins the current version, so the command
// never waits on an engine at localhost:3000.
async function update(...args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'zv-update-'));
  writeFileSync(join(dir, '.zveltio-install.json'), JSON.stringify({ version: '1.0.0' }));
  const proc = Bun.spawn(
    ['bun', join(import.meta.dir, '../index.ts'), 'update', '--dir', dir, ...args],
    {
      env: { ...process.env, ZVELTIO_VERSIONS_URL: `${server.url}versions.json` },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  return { code: await proc.exited, out };
}

describe('zveltio update with no stable release', () => {
  test('--channel beta finds the beta', async () => {
    const r = await update('--channel', 'beta', '--check');
    expect(r.out).toContain('v99.0.0-beta.1');
    expect(r.out).not.toContain('Invalid versions response');
  });

  test('the stable channel says there is none and points at beta', async () => {
    const r = await update('--check');
    expect(r.code).toBe(1);
    expect(r.out).toContain('No stable release has been published yet');
  });
});
