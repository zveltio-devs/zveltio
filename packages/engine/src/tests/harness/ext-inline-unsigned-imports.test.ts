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
 * And it runs only the bytes that signature lists, read as Bun loads them: an
 * entry the signature leaves out (`.zveltio-registry/`, a nested extension) or
 * one swapped after the checks is refused; a computed `import()` is refused
 * before it runs, a computed `require()` when it resolves outside (DR-TASKS
 * l.58, `inline-imports.ts`).
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
import * as extensionPaths from '../../lib/extensions/extension-paths.js';
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
const UNSIGNED_ENTRY = 'billing';
const NESTED_ENTRY = 'compliance/gdpr';
const SWAPPED = 'data/export';
const COMPUTED_IMPORT = 'developer/api-docs';
const COMPUTED_REQUIRE = 'developer/byod';
const REQUIRE_OUT = 'integrations/api-connector';
const REQUIRE_OK = 'sms';
const UPDATED = 'content/pages';
const ALL = [
  BARE,
  DYNAMIC,
  ESCAPE,
  BUILTINS,
  UNSIGNED_ENTRY,
  NESTED_ENTRY,
  SWAPPED,
  COMPUTED_IMPORT,
  COMPUTED_REQUIRE,
  REQUIRE_OUT,
  REQUIRE_OK,
  UPDATED,
];
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

  /** An entry that starts with `head` and records that it ran. */
  const entrySource = (name: string, head: string) =>
    `${head}\n` +
    `globalThis.__l57Ran = (globalThis.__l57Ran ?? []).concat(${JSON.stringify(name)});\n` +
    `export default { name: ${JSON.stringify(name)}, async register() {} };\n`;

  /** A bundled inline extension at `dir` whose `entry` is `entrySource(name, head)`, or absent. */
  function write(dir: string, name: string, head: string, entry = 'engine/index.js'): void {
    mkdirSync(join(dir, 'engine'), { recursive: true });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ name, version: '1.0.0', engine: { entry, bundled: true } }),
    );
    if (head !== '') writeFileSync(join(dir, entry), entrySource(name, head));
    // The loader looks for engine/index.js before it reads `engine.entry`.
    if (entry !== 'engine/index.js') writeFileSync(join(dir, 'engine', 'index.js'), '// signed\n');
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

  async function installAndLoad(
    name: string,
    head: string,
    opts: {
      /** `engine.entry`, when `head` is '' left out of the signed archive. */
      entry?: string;
      /** Runs on the installed directory after the download, before the load. */
      plant?: (extDir: string) => void;
      /** Runs as the load's import scan returns. */
      afterScan?: (extDir: string) => void;
    } = {},
  ): Promise<void> {
    write(join(src, name), name, head, opts.entry);
    await installSigned(name, join(src, name));
    opts.plant?.(join(base, name));
    const scan = extensionPaths.importOutsideDir;
    const scanSpy = spyOn(extensionPaths, 'importOutsideDir').mockImplementation((dir, entry) => {
      const why = scan(dir, entry);
      opts.afterScan?.(join(base, name));
      return why;
    });
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
      scanSpy.mockRestore();
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

  // DR-TASKS l.58: the entry is a file the signature lists, with those bytes.
  it('refuses an entry the signature does not list, planted in .zveltio-registry/', async () => {
    const entry = '.zveltio-registry/index.js';
    await installAndLoad(UNSIGNED_ENTRY, '', {
      entry,
      plant: (dir) => writeFileSync(join(dir, entry), entrySource(UNSIGNED_ENTRY, '')),
    });
    expect(ran(UNSIGNED_ENTRY)).toBe(false);
    expect(extensionLoader.loaded.has(UNSIGNED_ENTRY)).toBe(false);
    expect(extensionLoader.getLastLoadError(UNSIGNED_ENTRY)).toContain(
      `${entry} is not a file the extension's registry signature covers`,
    );
  }, 60_000);

  it('refuses an entry the signature does not list, planted as a nested extension', async () => {
    const entry = 'sub/engine/index.js';
    await installAndLoad(NESTED_ENTRY, '', {
      entry,
      plant: (dir) => {
        mkdirSync(join(dir, 'sub', 'engine'), { recursive: true });
        // A directory with a manifest of its own is a nested extension, which
        // `verifyRegistrySignedDir` leaves out of the comparison.
        writeFileSync(
          join(dir, 'sub', 'manifest.json'),
          JSON.stringify({ name: `${NESTED_ENTRY}/sub`, version: '1.0.0' }),
        );
        writeFileSync(join(dir, entry), entrySource(NESTED_ENTRY, ''));
      },
    });
    expect(ran(NESTED_ENTRY)).toBe(false);
    expect(extensionLoader.getLastLoadError(NESTED_ENTRY)).toContain(
      `${entry} is not a file the extension's registry signature covers`,
    );
  }, 60_000);

  it('refuses an entry swapped after the signature was verified and the imports read', async () => {
    await installAndLoad(SWAPPED, '// signed', {
      afterScan: (dir) =>
        writeFileSync(
          join(dir, 'engine', 'index.js'),
          entrySource(SWAPPED, 'globalThis.__l57Swapped = 1;'),
        ),
    });
    expect((globalThis as { __l57Swapped?: number }).__l57Swapped).toBeUndefined();
    expect(ran(SWAPPED)).toBe(false);
    expect(extensionLoader.getLastLoadError(SWAPPED)).toContain(
      "engine/index.js changed after the extension's registry signature was verified",
    );
  }, 60_000);

  // DR-TASKS l.58: a computed specifier is held to the same rules.
  it('refuses a computed import(); no code runs', async () => {
    await installAndLoad(
      COMPUTED_IMPORT,
      `const spec = [${JSON.stringify(PKG)}].join('');\nawait import(spec);`,
    );
    expect(g.__l57Pkg).toBeUndefined();
    expect(ran(COMPUTED_IMPORT)).toBe(false);
    expect(extensionLoader.getLastLoadError(COMPUTED_IMPORT)).toContain('computed import()');
  }, 60_000);

  it('refuses a computed require() of a bare specifier when it runs', async () => {
    await installAndLoad(
      COMPUTED_REQUIRE,
      `const req = import.meta.require;\nreq([${JSON.stringify(PKG)}].join(''));`,
    );
    expect(g.__l57Pkg).toBeUndefined();
    expect(ran(COMPUTED_REQUIRE)).toBe(false);
    expect(extensionLoader.getLastLoadError(COMPUTED_REQUIRE)).toContain(`requires "${PKG}"`);
  }, 60_000);

  it('refuses a computed require() of a path outside its directory when it runs', async () => {
    const out = join(base, 'node_modules', PKG, 'index.js');
    await installAndLoad(
      REQUIRE_OUT,
      `const req = import.meta.require;\nreq([${JSON.stringify(out)}].join(''));`,
    );
    expect(g.__l57Pkg).toBeUndefined();
    expect(ran(REQUIRE_OUT)).toBe(false);
    expect(extensionLoader.getLastLoadError(REQUIRE_OUT)).toContain(`requires "${out}"`);
  }, 60_000);

  it('runs one that requires runtime builtins through an alias, as bundles do', async () => {
    await installAndLoad(
      REQUIRE_OK,
      "var __require = import.meta.require;\n__require(['pa', 'th'].join(''));\n__require('node:fs');",
    );
    expect(extensionLoader.getLastLoadError(REQUIRE_OK)).toBeUndefined();
    expect(ran(REQUIRE_OK)).toBe(true);
  }, 60_000);

  it('runs the new signed bytes of an updated entry, from its cache-busting copy', async () => {
    type V = { __l58Version?: number };
    await installAndLoad(UPDATED, 'globalThis.__l58Version = 1;');
    expect((globalThis as V).__l58Version).toBe(1);
    await installAndLoad(UPDATED, 'globalThis.__l58Version = 2;');
    expect(extensionLoader.getLastLoadError(UPDATED)).toBeUndefined();
    expect((globalThis as V).__l58Version).toBe(2);
  }, 60_000);
});
