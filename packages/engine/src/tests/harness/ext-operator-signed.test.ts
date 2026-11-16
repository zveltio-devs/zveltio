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
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Hono } from 'hono';
import { signBundle, type ZveltioKeypair } from '@zveltio/sdk/publish';
import type { Database } from '../../db/index.js';
import * as extensionDownload from '../../lib/extensions/extension-download.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import { operatorSignedEntries } from '../../lib/extensions/extension-marketplace-routes.js';
import { extensionDirListing } from '../../lib/security/index.js';
import { ensureWorkerRuntimeOnDisk } from '../../lib/ext-runner.js';
import { _resetWorkerHostForTests, getWorkerHost } from '../../lib/worker-extension-host.js';
import type { InitResponse } from '../../lib/worker-extension-protocol.js';
import { spawnProcessRunner } from '../../lib/worker-extension-transport.js';
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
  function write(
    name: string,
    engine: Record<string, unknown> = {},
    /** Replaces the bundle's `register()` and what comes before the export. */
    bundle?: { before?: string; register?: string },
  ): string {
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
        (bundle?.before ?? '') +
        `export default { name: '${name}', ${bundle?.register ?? `async register() { console.warn('hello from ${name}'); }`} };\n`,
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

  it('marketplace lists a signed directory at any depth, and not one whose signature fails', async () => {
    const deep = `s3${STAMP}/list/deep`;
    const bent = `s3${STAMP}/list/bent`;
    sign(write(deep));
    sign(write(bent));
    appendFileSync(join(base, bent, 'engine', 'index.js'), '\n// changed after signing\n');
    const warn = spyOn(console, 'warn');
    try {
      const listed = (await operatorSignedEntries(base, new Set())).map((e) => e.name);
      expect(listed).toContain(deep);
      expect(listed).not.toContain(bent);
      expect((await operatorSignedEntries(base, new Set([deep]))).map((e) => e.name)).not.toContain(
        deep,
      );
    } finally {
      warn.mockRestore();
    }
  });

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

  // ── Slice 4: level 3 is declared model only ──────────────────────────────

  it('fails the load of a register() that uses its app or its ctx (s4)', async () => {
    for (const [what, register] of [
      ['app', `async register(app) { app.get('/x', (c) => c.text('x')); }`],
      ['ctx', `async register(_app, ctx) { await ctx.db.query('select 1 as n'); }`],
    ] as const) {
      const name = `s3${STAMP}/reg-${what}`;
      sign(write(name, {}, { register }));
      expect(await load(name)).toMatch(
        new RegExp(`register\\(\\) used ${what}\\.\\w+: .*declared model only`),
      );
      expect(running(name)).toBe(false);
    }
  }, 60_000);

  it('refuses on the host what register()’s ctx would send, even as a forged frame (s4)', async () => {
    const name = `s3${STAMP}/forged`;
    // Written straight to the channel at import, past the runtime; the answers
    // are read off the frames the runtime parses.
    const before = `import { writeSync } from 'node:fs';
const frame = (m) => { const b = new TextEncoder().encode(JSON.stringify(m)); const o = new Uint8Array(4 + b.length); new DataView(o.buffer).setUint32(0, b.length); o.set(b, 4); return o; };
const parse = JSON.parse;
JSON.parse = (t, r) => { const v = parse(t, r); if (v && String(v.id).startsWith('forged-')) console.warn('forged ' + v.id + ' ' + v.type + ' ' + (v.error ?? JSON.stringify(v.rows ?? v.result ?? null))); return v; };
for (const m of [
  { type: 'db:query', id: 'forged-db', sql: 'select 42 as n', params: [] },
  { type: 'host:call', id: 'forged-host', op: 'getUserRoles', args: ['u'] },
  { type: 'service:register', id: 'forged-reg', name: 'forged.svc' },
  { type: 'service:call', id: 'forged-call', name: 'forged.svc', args: [] },
]) writeSync(1, frame(m));
`;
    sign(write(name, {}, { before, register: 'async register() {}' }));
    const warn = spyOn(console, 'warn');
    const error = spyOn(console, 'error');
    try {
      expect(await load(name)).toBeUndefined();
      const replies = () =>
        warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('] forged '));
      for (let i = 0; i < 60 && replies().length < 4; i++) await Bun.sleep(50);
      for (const id of ['forged-db', 'forged-host', 'forged-reg', 'forged-call']) {
        expect(replies().find((l) => l.includes(` ${id} `))).toMatch(
          /:err .* is refused: .*level 3.*declared model only/,
        );
      }
      expect(
        error.mock.calls.some((c) =>
          String(c[0]).startsWith(`[ext:${name} key=${KEY}] ctx.db is refused`),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  }, 60_000);

  it('refuses raw SQL migrations: a level-3 extension declares its collections (s4)', async () => {
    const name = `s3${STAMP}/migr`;
    const dir = write(name);
    mkdirSync(join(dir, 'engine', 'migrations'));
    writeFileSync(join(dir, 'engine', 'migrations', '001_x.sql'), 'SELECT 1;\n');
    sign(dir);
    expect(await load(name)).toMatch(/declared model only: declare its collections/);
    expect(running(name)).toBe(false);
  }, 60_000);

  it('verifies the signature again before a crash respawn imports the bundle (s4)', async () => {
    const name = `s3${STAMP}/respawn`;
    const dir = write(name);
    sign(dir);
    expect(await load(name)).toBeUndefined();
    appendFileSync(join(dir, 'engine', 'index.js'), `console.warn('tampered ${name}');\n`);
    const errors = spyOn(console, 'error');
    const warn = spyOn(console, 'warn');
    try {
      const host = getWorkerHost(app) as unknown as {
        workers: Map<string, { worker: { onerror: ((e: ErrorEvent) => void) | null } }>;
      };
      host.workers.get(name)?.worker.onerror?.({ message: 'test crash' } as ErrorEvent);
      const failed = () =>
        errors.mock.calls.some(
          (c) =>
            String(c[0]).startsWith(`[ext:${name} key=${KEY}] respawn failed`) &&
            String(c[0]).includes('no longer matches what key'),
        );
      for (let i = 0; i < 100 && !failed(); i++) await Bun.sleep(50);
      expect(failed()).toBe(true);
      expect(warn.mock.calls.some((c) => String(c[0]).includes(`tampered ${name}`))).toBe(false);
    } finally {
      errors.mockRestore();
      warn.mockRestore();
      await getWorkerHost(app).stop(name);
    }
  }, 60_000);

  it('imports only bytes that hash to the signed sha256, read once by the worker (s4)', async () => {
    const name = `s3${STAMP}/bytes`;
    const dir = write(name, {}, { register: 'async register() {}' });
    const file = join(dir, 'engine', 'index.js');
    const ch = spawnProcessRunner(ensureWorkerRuntimeOnDisk(), { NODE_ENV: 'test' });
    const init = (bundleSha256: string) =>
      new Promise<InitResponse>((resolve) => {
        ch.onmessage = (e) => {
          if (e.data.type === 'init:ok' || e.data.type === 'init:err') resolve(e.data);
        };
        ch.postMessage({
          type: 'init',
          id: `init-${bundleSha256.slice(0, 4)}`,
          bundleUrl: pathToFileURL(file).href,
          bundleSha256,
          declaredOnly: true,
          extName: name,
          env: { extensionPath: dir },
        });
      });
    try {
      expect((await init('0'.repeat(64))).error).toMatch(/not what its signature lists/);
      const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
      expect((await init(sha)).type).toBe('init:ok');
    } finally {
      ch.terminate();
    }
  }, 60_000);
});
