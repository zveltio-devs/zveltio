// `zveltio extension validate`: a page may call a route the manifest declares
// (ADR 0039), which the engine mounts itself and no `.get('…')` in the source names.
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '..', 'index.ts');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function validate(routes: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'zv-routes-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'studio', 'schemas'), { recursive: true });
  mkdirSync(join(dir, 'engine'), { recursive: true });
  writeFileSync(join(dir, 'engine', 'index.ts'), 'export default { name: "sso" };\n');
  writeFileSync(
    join(dir, 'studio', 'schemas', 'sso.json'),
    JSON.stringify({
      sduiSchema: 1,
      title: 'SSO',
      resources: [{ id: 'meta', endpoint: '/ext/sso/metadata' }],
      layout: { type: 'stack', children: [] },
    }),
  );
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      name: 'sso',
      displayName: 'SSO',
      category: 'auth',
      description: 'd',
      version: '1.0.0',
      routes,
      studio: { pages: [{ path: '/admin/sso', label: 'SSO', schema: 'schemas/sso.json' }] },
    }),
  );
  const proc = Bun.spawnSync(['bun', CLI, 'extension', 'validate', '--dir', dir, '--first-party']);
  const out = proc.stdout.toString() + proc.stderr.toString();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour codes
  return /SDUI schemas: +(.*)/.exec(out.replace(/\x1b\[[0-9;]*m/g, ''))?.[1] ?? out;
}

describe('extension validate: declared routes are provided routes', () => {
  it('takes a page endpoint the manifest declares, and refuses one it does not', () => {
    const route = { method: 'GET', path: '/metadata', access: 'public', handler: 'metadata' };
    expect(validate([route])).toBe('1 OK');
    expect(validate([{ ...route, path: '/other' }])).toBe('1 error(s)');
  }, 60_000);
});
