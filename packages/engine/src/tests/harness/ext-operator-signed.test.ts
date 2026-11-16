/**
 * ADR 0056 slice 3 (RFC v3 phase A): an extension signed with a key on the
 * operator's own list loads at level 3 — on the runner, never inline — and the
 * signature is verified at every load, so it cannot be bent after signing.
 *
 * Signed the way an operator signs, with the CLI (`zveltio keys generate`,
 * `zveltio extension sign`), and loaded through the engine's own loader from a
 * directory on disk. This also holds the CLI's listing and the engine's together.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { signBundle, type ZveltioKeypair } from '@zveltio/sdk/publish';
import type { Database } from '../../db/index.js';
import * as extensionDownload from '../../lib/extensions/extension-download.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import { extensionDirListing } from '../../lib/security/index.js';
import { _resetWorkerHostForTests, getWorkerHost } from '../../lib/worker-extension-host.js';
import {
  forgetInstalled,
  getTestApp,
  harnessAvailable,
  markInstalled,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = String(Date.now()).slice(-7);
const KEY = `ops-${STAMP}`;
// The CLI from source, as `ext-schema-integrity` runs it: CI builds no CLI dist for this lane.
const CLI = join(import.meta.dir, '../../../../cli/src/index.ts');
const names: string[] = [];

d('an operator-signed extension (ADR 0056 s3)', () => {
  let db: Database;
  let base = '';
  let home = '';
  let trusted = '';
  const app = new Hono();
  const saved = {
    transport: process.env.ZVELTIO_EXT_TRANSPORT,
    operator: process.env.OPERATOR_PUBLIC_KEYS_JSON,
    registry: process.env.REGISTRY_PUBLIC_KEYS_JSON,
  };

  function cli(...args: string[]): string {
    const r = Bun.spawnSync(['bun', CLI, ...args], { env: { ...process.env, HOME: home } });
    if (r.exitCode !== 0) throw new Error(`zveltio ${args.join(' ')}: ${r.stderr}${r.stdout}`);
    return r.stdout.toString();
  }

  /** A bundled worker extension whose register() logs, and whose top level marks an inline import. */
  function write(name: string, engine: Record<string, unknown> = {}): string {
    names.push(name);
    const dir = join(base, name);
    mkdirSync(join(dir, 'engine'), { recursive: true });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        engine: { entry: 'engine/index.js', bundled: true, isolation: 'worker', ...engine },
      }),
    );
    writeFileSync(
      join(dir, 'engine', 'index.js'),
      `globalThis.__imported_${STAMP} = (globalThis.__imported_${STAMP} ?? []).concat('${name}');\n` +
        `export default { name: '${name}', async register() { console.warn('hello from ${name}'); } };\n`,
    );
    return dir;
  }
  const sign = (dir: string) => cli('extension', 'sign', '--dir', dir, '--key-id', KEY);
  const ctx = () => extensionLoader.ctx ?? ({ db, fieldTypeRegistry: { register() {} } } as never);
  async function load(name: string): Promise<string | undefined> {
    await markInstalled(db, name);
    await extensionLoader.loadExtension(name, app, ctx(), base);
    return extensionLoader.getLastLoadError(name);
  }
  const running = (name: string) => getWorkerHost(app).isRunning(name);
  const importedInline = () =>
    ((globalThis as Record<string, unknown>)[`__imported_${STAMP}`] as string[] | undefined) ?? [];

  beforeAll(async () => {
    db = (await getTestApp()).db;
    base = mkdtempSync(join(tmpdir(), 'op-signed-'));
    home = mkdtempSync(join(tmpdir(), 'op-home-'));
    process.env.ZVELTIO_EXT_TRANSPORT = 'process';
    _resetWorkerHostForTests();
    getWorkerHost(app);
    cli('keys', 'generate', '--id', KEY);
    trusted = cli('keys', 'export', KEY);
    process.env.OPERATOR_PUBLIC_KEYS_JSON = trusted;
  });

  afterEach(() => {
    process.env.OPERATOR_PUBLIC_KEYS_JSON = trusted;
    if (saved.registry === undefined) delete process.env.REGISTRY_PUBLIC_KEYS_JSON;
    else process.env.REGISTRY_PUBLIC_KEYS_JSON = saved.registry;
    _setInlineForTests(false);
  });

  afterAll(async () => {
    await getWorkerHost(app).stopAll();
    _resetWorkerHostForTests();
    for (const name of names) {
      await extensionLoader.unload(name).catch(() => {});
      await forgetInstalled(db, name);
    }
    for (const [k, v] of Object.entries({
      ZVELTIO_EXT_TRANSPORT: saved.transport,
      OPERATOR_PUBLIC_KEYS_JSON: saved.operator,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(base, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('loads at level 3 on the runner, never imported here, its key named in health and logs', async () => {
    const name = `s3${STAMP}/ok`;
    sign(write(name));
    const warn = spyOn(console, 'warn');
    try {
      expect(await load(name)).toBeUndefined();
      expect(running(name)).toBe(true);
      expect(importedInline()).not.toContain(name);
      const health = getWorkerHost(app)
        .getHealth()
        .find((h) => h.name === name);
      expect(health?.keyId).toBe(KEY);
      for (let i = 0; i < 40 && !warn.mock.calls.some((c) => /hello from/.test(String(c[0]))); i++)
        await Bun.sleep(50);
      expect(warn.mock.calls.map((c) => String(c[0]))).toContain(
        `[ext:${name} key=${KEY}] hello from ${name}`,
      );
    } finally {
      warn.mockRestore();
    }
  }, 60_000);

  it('refuses a key not on the operator list — no fallback to loading it unsigned', async () => {
    const name = `s3${STAMP}/unknown`;
    sign(write(name));
    process.env.OPERATOR_PUBLIC_KEYS_JSON = '[]';
    expect(await load(name)).toMatch(/not on this engine's operator key list/);
    expect(running(name)).toBe(false);
    expect(extensionLoader.loaded.has(name)).toBe(false);
  }, 60_000);

  it('keeps the operator list apart from the registry list', async () => {
    const name = `s3${STAMP}/registry`;
    sign(write(name));
    process.env.REGISTRY_PUBLIC_KEYS_JSON = trusted;
    process.env.OPERATOR_PUBLIC_KEYS_JSON = '[]';
    expect(await load(name)).toMatch(/operator key list/);
    expect(running(name)).toBe(false);
  }, 60_000);

  it('refuses a signature claiming a tier an operator key cannot confer', async () => {
    for (const tier of ['first-party', 'certified']) {
      const name = `s3${STAMP}/${tier}`;
      const dir = write(name);
      const kp = JSON.parse(
        readFileSync(join(home, '.zveltio', 'keys', `${KEY}.json`), 'utf8'),
      ) as ZveltioKeypair;
      // Signed properly, over the listing naming that tier: only the claim is wrong.
      const env = await signBundle(extensionDirListing(dir, name, tier), kp);
      writeFileSync(join(dir, 'signature.json'), JSON.stringify({ ...env, tier }));
      expect(await load(name)).toMatch(/confers level 3 \("private"\) only/);
      expect(running(name)).toBe(false);
    }
  }, 60_000);

  it('never runs inline: not when the catalogue calls the name first-party, not under the test override', async () => {
    const name = `s3${STAMP}/inline`;
    sign(write(name, { isolation: undefined }));
    const spy = spyOn(extensionDownload, 'fetchRegistryCatalog').mockResolvedValue([
      { name, publisher_tier: 'first-party' } as never,
    ]);
    try {
      expect(await load(name)).toMatch(/level 3, private.*never inline/);
      _setInlineForTests(true);
      expect(await load(name)).toMatch(/never inline/);
    } finally {
      spy.mockRestore();
    }
    expect(importedInline()).not.toContain(name);
    expect(extensionLoader.loaded.has(name)).toBe(false);
  }, 60_000);

  it('refuses a directory changed after signing: bundle, manifest, an added file, a new name', async () => {
    const tampers: [string, (dir: string) => void][] = [
      ['bundle', (dir) => appendFileSync(join(dir, 'engine', 'index.js'), '// changed\n')],
      [
        'manifest',
        (dir) => {
          const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
          writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...m, version: '1.0.1' }));
        },
      ],
      ['added', (dir) => writeFileSync(join(dir, 'engine', 'extra.js'), 'export {};\n')],
    ];
    for (const [what, tamper] of tampers) {
      const name = `s3${STAMP}/t-${what}`;
      const dir = write(name);
      sign(dir);
      tamper(dir);
      expect(await load(name)).toMatch(/no longer matches what key/);
      expect(running(name)).toBe(false);
    }
    // A signed directory copied under another name is not what was signed.
    const from = `s3${STAMP}/t-source`;
    sign(write(from));
    const renamed = `s3${STAMP}/t-renamed`;
    names.push(renamed);
    cpSync(join(base, from), join(base, renamed), { recursive: true });
    expect(await load(renamed)).toMatch(/no longer matches what key/);
    expect(existsSync(join(base, renamed, 'signature.json'))).toBe(true);
  }, 60_000);

  it('leaves an unsigned worker extension as it was: community, on the runner, key absent', async () => {
    const name = `s3${STAMP}/unsigned`;
    write(name);
    expect(await load(name)).toBeUndefined();
    expect(running(name)).toBe(true);
    expect(
      getWorkerHost(app)
        .getHealth()
        .find((h) => h.name === name)?.keyId,
    ).toBeNull();
  }, 60_000);
});
