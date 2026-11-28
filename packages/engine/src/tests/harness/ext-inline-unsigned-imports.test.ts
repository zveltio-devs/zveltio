/**
 * An inline extension imports only code its registry signature covers.
 *
 * The signature covers the extension's directory (`verifyRegistrySignedDir`),
 * but its bundle is imported in the engine process from a file:// URL, so a
 * bare specifier walks up past it: to `<EXTENSIONS_DIR>/node_modules`, where
 * the engine installs core packages and peers, and to every ancestor's
 * `node_modules`. None of those is signed. A relative or absolute path out of
 * the directory reaches the same files. Each is refused before the import, so
 * the bundle's top-level code never runs (DR-TASKS l.57).
 *
 * Production, through the engine's own download path and loader, as
 * `ext-unsigned-never-inline` runs it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportTrustedKeyEntry, generateKeypair, signBundle } from '@zveltio/sdk/publish';
import { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import * as extensionDownload from '../../lib/extensions/extension-download.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import {
  forgetInstalled,
  getTestApp,
  harnessAvailable,
  markInstalled,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = String(Date.now()).slice(-7);
// Names on the engine's inline list (ADR 0062 d1): any other name runs as a worker.
const BARE = 'content/documents';
const DYNAMIC = 'content/document-templates';
const ESCAPE = 'operations/traceability';
const BUILTINS = 'analytics/dashboard';
const ALL = [BARE, DYNAMIC, ESCAPE, BUILTINS];
const PKG = `zv-unsigned-${STAMP}`;

type Ran = { __l57Ran?: string[]; __l57Pkg?: number };
const g = globalThis as Ran;
const ran = (name: string) => (g.__l57Ran ?? []).includes(name);

d('an inline extension imports only code its registry signature covers', () => {
  let db: Database;
  let base: string;
  let src: string;
  const app = new Hono();
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    REGISTRY_PUBLIC_KEYS_JSON: process.env.REGISTRY_PUBLIC_KEYS_JSON,
  };
  let wasInline = false;
  const ctx = () => extensionLoader.ctx ?? ({ db, fieldTypeRegistry: { register() {} } } as never);

  /** A bundled inline extension whose entry starts with `head` and records that it ran. */
  function write(dir: string, name: string, head: string): void {
    mkdirSync(join(dir, 'engine'), { recursive: true });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        engine: { entry: 'engine/index.js', bundled: true },
      }),
    );
    writeFileSync(
      join(dir, 'engine', 'index.js'),
      `${head}\n` +
        `globalThis.__l57Ran = (globalThis.__l57Ran ?? []).concat(${JSON.stringify(name)});\n` +
        `export default { name: ${JSON.stringify(name)}, async register() {} };\n`,
    );
  }

  /** Installs `name` through the engine's download path, from a registry serving `dir` signed. */
  async function installSigned(name: string, dir: string): Promise<void> {
    const archive = join(src, `${name.replace('/', '-')}.tar.gz`);
    expect(Bun.spawnSync(['tar', '-czf', archive, '-C', dir, '.']).exitCode).toBe(0);
    const bytes = new Uint8Array(readFileSync(archive));
    const kp = await generateKeypair(`l57-registry-${STAMP}`);
    process.env.REGISTRY_PUBLIC_KEYS_JSON = JSON.stringify([
      await exportTrustedKeyEntry(kp.keyId, kp.publicJwk),
    ]);
    const sig = await signBundle(bytes, kp);
    const url = `https://registry.l57.invalid/${name}.tar.gz`;
    const realFetch = globalThis.fetch;
    const spy = spyOn(globalThis, 'fetch').mockImplementation((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const u = String(input);
      if (u === url) return new Response(bytes);
      if (u === `${url}.sig`) return Response.json(sig);
      return realFetch(input, init);
    }) as typeof fetch);
    try {
      await extensionDownload.downloadExtension(
        { name, version: '1.0.0', download_url: url } as never,
        base,
      );
    } finally {
      spy.mockRestore();
    }
  }

  async function installAndLoad(name: string, head: string): Promise<void> {
    write(join(src, name), name, head);
    await installSigned(name, join(src, name));
    await markInstalled(db, name);
    // A file before this one in the same `bun test` run may have loaded the name.
    await extensionLoader.unload(name).catch(() => {});
    extensionLoader.lastLoadError.delete(name);
    const spy = spyOn(extensionDownload, 'fetchRegistryCatalog').mockResolvedValue([
      { name, publisher_tier: 'first-party' } as never,
    ]);
    try {
      await extensionLoader.loadExtension(name, app, ctx(), base);
    } finally {
      spy.mockRestore();
    }
  }

  beforeAll(async () => {
    db = (await getTestApp()).db;
    base = mkdtempSync(join(tmpdir(), 'l57-exts-'));
    src = mkdtempSync(join(tmpdir(), 'l57-src-'));
    wasInline = _setInlineForTests(false);
    process.env.NODE_ENV = 'production';
    // An unsigned package where the engine installs peers and core packages:
    // <EXTENSIONS_DIR>/node_modules, outside every extension's directory.
    const pkg = join(base, 'node_modules', PKG);
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({ name: PKG, version: '1.0.0', type: 'module', main: 'index.js' }),
    );
    writeFileSync(
      join(pkg, 'index.js'),
      'globalThis.__l57Pkg = (globalThis.__l57Pkg ?? 0) + 1;\nexport default 1;\n',
    );
  });

  afterEach(() => {
    extensionDownload._resetCatalogCacheForTests();
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _setInlineForTests(wasInline);
    for (const name of ALL) await extensionLoader.unload(name).catch(() => {});
    await forgetInstalled(db, ...ALL);
    rmSync(base, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });

  it('refuses a bare specifier that resolves outside its directory; no code runs', async () => {
    await installAndLoad(BARE, `import pkg from ${JSON.stringify(PKG)};`);
    expect(g.__l57Pkg).toBeUndefined();
    expect(ran(BARE)).toBe(false);
    expect(extensionLoader.loaded.has(BARE)).toBe(false);
    expect(extensionLoader.getLastLoadError(BARE)).toContain(`"${PKG}"`);
  }, 60_000);

  it('refuses a literal dynamic import of one too', async () => {
    await installAndLoad(DYNAMIC, `await import(${JSON.stringify(PKG)});`);
    expect(g.__l57Pkg).toBeUndefined();
    expect(ran(DYNAMIC)).toBe(false);
    expect(extensionLoader.getLastLoadError(DYNAMIC)).toContain(`"${PKG}"`);
  }, 60_000);

  it('refuses a relative path out of its directory', async () => {
    const out = `../../node_modules/${PKG}/index.js`;
    await installAndLoad(ESCAPE, `import pkg from ${JSON.stringify(`../${out}`)};`);
    expect(g.__l57Pkg).toBeUndefined();
    expect(ran(ESCAPE)).toBe(false);
    expect(extensionLoader.getLastLoadError(ESCAPE)).toContain(out);
  }, 60_000);

  it('runs one that imports only runtime builtins, bare or prefixed', async () => {
    await installAndLoad(
      BUILTINS,
      "import { join } from 'path';\nimport { createHash } from 'node:crypto';\nimport 'bun';",
    );
    expect(extensionLoader.getLastLoadError(BUILTINS)).toBeUndefined();
    expect(ran(BUILTINS)).toBe(true);
  }, 60_000);
});
