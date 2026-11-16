// `zveltio install <name> --path <dir>` (ADR 0056 s3, LV-05): an operator's own
// extension, named `category/name` as every v2 manifest is, lands under
// EXTENSIONS_DIR at that path — and only once its signature verifies, as the
// engine will verify it at load. Run as an operator runs it: the CLI process.
import { afterAll, beforeAll, expect, it } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '../index.ts');
const root = mkdtempSync(join(tmpdir(), 'zv-cli-path-'));
const home = join(root, 'home');
const exts = join(root, 'exts');
const src = join(root, 'src');
const NAME = 'acme/private';

function cli(args: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync(['bun', CLI, ...args], {
    env: { ...process.env, HOME: home, EXTENSIONS_DIR: exts, ...env },
  });
  return { code: r.exitCode, out: `${r.stdout}${r.stderr}` };
}

beforeAll(() => {
  mkdirSync(join(src, 'engine'), { recursive: true });
  writeFileSync(
    join(src, 'manifest.json'),
    JSON.stringify({
      name: NAME,
      version: '1.0.0',
      engine: { entry: 'engine/index.js', bundled: true, isolation: 'worker' },
    }),
  );
  writeFileSync(join(src, 'engine', 'index.js'), 'export default { async register() {} };\n');
  expect(cli(['keys', 'generate', '--id', 'acme-ops']).code).toBe(0);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

it('refuses an unsigned directory', () => {
  const r = cli(['install', NAME, '--path', src]);
  expect(r.code).not.toBe(0);
  expect(r.out).toContain('is not signed');
  expect(existsSync(join(exts, NAME))).toBe(false);
});

it('installs a signed category/name extension under EXTENSIONS_DIR', () => {
  expect(cli(['extension', 'sign', '--dir', src]).code).toBe(0);
  const r = cli(['install', NAME, '--path', src]);
  expect(r.out).toContain('Signed:   key "acme-ops"');
  expect(r.code).toBe(0);
  expect(existsSync(join(exts, NAME, 'signature.json'))).toBe(true);
});

it("refuses a key the engine's operator list does not name", () => {
  const r = cli(['install', NAME, '--path', src, '--force'], {
    OPERATOR_PUBLIC_KEYS_JSON: '[{"keyId":"someone-else","publicKeyHex":"00"}]',
  });
  expect(r.code).not.toBe(0);
  expect(r.out).toContain('signed with key "acme-ops", which is neither');
});

it('refuses a directory changed after signing, and leaves the installed copy alone', () => {
  appendFileSync(join(src, 'engine', 'index.js'), '// changed\n');
  const r = cli(['install', NAME, '--path', src, '--force']);
  expect(r.code).not.toBe(0);
  expect(r.out).toContain('no longer matches what key "acme-ops" signed');
  expect(existsSync(join(exts, NAME, 'signature.json'))).toBe(true);
});
