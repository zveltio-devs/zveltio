/**
 * `zveltio extension publish`, run as a user runs it, on a minimal extension.
 *
 * - The validation a publish runs is on what ships: pack and the Studio build
 *   come first, so an extension never packed publishes in one command.
 * - A hard validation failure stops the publish with exit 1 before anything
 *   is archived, signed or uploaded. It used to print the failure and go on to
 *   upload, exit 0: `silentExit` returned where it should have thrown.
 */

import { afterAll, beforeAll, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '..', 'index.ts');
let root: string;
let home: string;

const run = (args: string[], cwd: string) =>
  Bun.spawnSync([process.execPath, CLI, ...args], {
    cwd,
    env: { ...process.env, HOME: home, ZVELTIO_REGISTRY_URL: 'http://127.0.0.1:9' },
    stdout: 'pipe',
    stderr: 'pipe',
  });

/** `<root>/<case>/test/mini`: validate wants the name to match the trailing folders. */
function extension(name: string): { dir: string; out: string } {
  const dir = join(root, name, 'test', 'mini');
  mkdirSync(join(dir, 'engine'), { recursive: true });
  writeFileSync(join(dir, 'engine', 'index.ts'), 'export default { name: "test/mini" };\n');
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      name: 'test/mini',
      version: '1.0.0',
      displayName: 'Mini',
      description: 'd',
      category: 'test',
      zveltioMinVersion: '1.0.0',
    }),
  );
  return { dir, out: join(root, name, 'out') };
}

const publish = (dir: string, out: string) =>
  run(['extension', 'publish', '--first-party', '--key-id', 'k', '--output', out], dir);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'zv-publish-flow-'));
  home = join(root, 'home');
  mkdirSync(home);
  expect(run(['keys', 'generate', '--id', 'k'], root).exitCode).toBe(0);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

it('packs before it validates, so a never-packed extension publishes', () => {
  const { dir, out } = extension('fresh');
  const r = publish(dir, out);
  expect(r.stdout.toString()).toContain('Step 3/6: validate');
  expect(r.exitCode).toBe(0);
  expect(readdirSync(out).sort()).toEqual(['test__mini-1.0.0.zvext', 'test__mini-1.0.0.zvext.sig']);
}, 60_000);

it('stops with exit 1, nothing archived, when validation fails', () => {
  const { dir, out } = extension('invalid');
  // Packed, so validate gets past the v1-manifest refusal (which always threw)
  // to the checks that only printed and returned.
  expect(run(['extension', 'pack', '--first-party'], dir).exitCode).toBe(0);
  mkdirSync(join(dir, 'engine', 'migrations'));
  writeFileSync(join(dir, 'engine', 'migrations', '001_drop.sql'), '-- UP\nDROP TABLE t;\n');
  const r = publish(dir, out);
  expect(r.stdout.toString()).toContain('Validation failed');
  expect(r.stdout.toString()).not.toContain('Step 4/6: archive');
  expect(r.exitCode).toBe(1);
  expect(existsSync(out)).toBe(false);
}, 60_000);
