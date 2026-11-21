/**
 * U3 (ADR 0056 amendment 4, ADR 0058 amendment point 3): an unsigned directory
 * never runs inline, whatever its name. A name the catalogue calls first-party
 * proves nothing: inline needs the registry's signature, kept with the files at
 * download and re-verified against them at every load.
 *
 * Production (the default `NODE_ENV`) through the engine's own loader and
 * download path, from directories on disk; development and test refuse the
 * same (ADR 0056 amendment 2026-11-21: no local-dev exception), and run a
 * source checkout signed with `scripts/sign-as-registry.ts --key-id`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const UNSIGNED = `u3plain${STAMP}`;
const SIGNED = `u3signed${STAMP}`;
const TAMPERED = `u3tamper${STAMP}`;
const BORROWED = `u3borrow${STAMP}`;
const ALL = [UNSIGNED, SIGNED, TAMPERED, BORROWED];
// The CLI from source, as `ext-operator-signed` runs it: CI builds no CLI dist for this lane.
const CLI = join(import.meta.dir, '../../../../cli/src/index.ts');
const SIGN = join(import.meta.dir, '../../../../../scripts/sign-as-registry.ts');

type Ran = { __u3Ran?: string[] };
const ran = (name: string) => ((globalThis as Ran).__u3Ran ?? []).includes(name);

d('an unsigned directory never runs inline, whatever its name (U3)', () => {
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

  /** An inline (not worker-isolated) extension whose top-level code records that it ran. */
  function write(dir: string, name: string): void {
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
      `globalThis.__u3Ran = (globalThis.__u3Ran ?? []).concat(${JSON.stringify(name)});\n` +
        `export default { name: ${JSON.stringify(name)}, async register() {} };\n`,
    );
  }

  /** Installs `name` through the engine's download path, from a registry serving `archiveOf`'s files signed. */
  async function installSigned(name: string, archiveOf: string): Promise<void> {
    const archive = join(src, `${name}.tar.gz`);
    const tar = Bun.spawnSync(['tar', '-czf', archive, '-C', archiveOf, '.']);
    expect(tar.exitCode).toBe(0);
    const bytes = new Uint8Array(readFileSync(archive));
    const kp = await generateKeypair(`u3-registry-${STAMP}`);
    process.env.REGISTRY_PUBLIC_KEYS_JSON = JSON.stringify([
      await exportTrustedKeyEntry(kp.keyId, kp.publicJwk),
    ]);
    const sig = await signBundle(bytes, kp);
    const url = `https://registry.u3.invalid/${name}.tar.gz`;
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

  async function load(name: string): Promise<void> {
    await markInstalled(db, name);
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
    base = mkdtempSync(join(tmpdir(), 'u3-exts-'));
    src = mkdtempSync(join(tmpdir(), 'u3-src-'));
    // Module state shared by every file of one `bun test` run: a file before this
    // one may have left the override on (proved: drop this line, run ext-action-files first).
    wasInline = _setInlineForTests(false);
    process.env.NODE_ENV = 'production';
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

  it('refuses an unsigned directory the catalogue calls first-party; its code never runs', async () => {
    write(join(base, UNSIGNED), UNSIGNED);
    await load(UNSIGNED);
    expect(ran(UNSIGNED)).toBe(false);
    expect(extensionLoader.loaded.has(UNSIGNED)).toBe(false);
    expect(extensionLoader.getLastLoadError(UNSIGNED)).toMatch(/not signed by the registry/);
  }, 60_000);

  // ADR 0056 amendment 2026-11-21 point 2: no local-dev exception. A source
  // checkout under `NODE_ENV=development` or `test` is refused like any other.
  for (const mode of ['development', 'test']) {
    it(`refuses it under NODE_ENV=${mode} too: no local-dev exception`, async () => {
      const name = `${UNSIGNED}${mode[0]}`;
      ALL.push(name);
      write(join(base, name), name);
      process.env.NODE_ENV = mode;
      try {
        await load(name);
      } finally {
        process.env.NODE_ENV = 'production';
      }
      expect(ran(name)).toBe(false);
      expect(extensionLoader.loaded.has(name)).toBe(false);
      expect(extensionLoader.getLastLoadError(name)).toMatch(/not signed by the registry/);
    }, 60_000);
  }

  it('runs a source checkout a developer signed with their own test key (development)', async () => {
    const name = `u3dev${STAMP}`;
    ALL.push(name);
    write(join(base, name), name);
    const home = mkdtempSync(join(tmpdir(), 'u3-home-'));
    const run = (cmd: string[]) => {
      const r = Bun.spawnSync(cmd, { env: { ...process.env, HOME: home } });
      expect(r.stderr.toString()).not.toMatch(/error|usage/i);
      expect(r.exitCode).toBe(0);
      return r.stdout.toString();
    };
    try {
      run(['bun', CLI, 'keys', 'generate', '--id', `dev-${STAMP}`]);
      const sign = ['bun', SIGN, base, name, '--key-id', `dev-${STAMP}`];
      const line = run(sign).trim();
      expect(line).toBe(run(sign).trim()); // the same key on every run: one .env line
      process.env.REGISTRY_PUBLIC_KEYS_JSON = line.slice('REGISTRY_PUBLIC_KEYS_JSON='.length);
      process.env.NODE_ENV = 'development';
      await load(name);
    } finally {
      process.env.NODE_ENV = 'production';
      rmSync(home, { recursive: true, force: true });
    }
    expect(extensionLoader.getLastLoadError(name)).toBeUndefined();
    expect(ran(name)).toBe(true);
  }, 60_000);

  it('runs inline what the registry signed, re-verified at load', async () => {
    write(join(src, SIGNED), SIGNED);
    await installSigned(SIGNED, join(src, SIGNED));
    await load(SIGNED);
    expect(extensionLoader.getLastLoadError(SIGNED)).toBeUndefined();
    expect(extensionLoader.loaded.has(SIGNED)).toBe(true);
    expect(ran(SIGNED)).toBe(true);
  }, 60_000);

  it('refuses a signed directory whose files changed after the download', async () => {
    write(join(src, TAMPERED), TAMPERED);
    await installSigned(TAMPERED, join(src, TAMPERED));
    writeFileSync(
      join(base, TAMPERED, 'engine', 'index.js'),
      `globalThis.__u3Ran = (globalThis.__u3Ran ?? []).concat(${JSON.stringify(TAMPERED)});\n` +
        `export default { name: ${JSON.stringify(TAMPERED)}, async register() {} }; // changed\n`,
    );
    await load(TAMPERED);
    expect(ran(TAMPERED)).toBe(false);
    expect(extensionLoader.loaded.has(TAMPERED)).toBe(false);
    expect(extensionLoader.getLastLoadError(TAMPERED)).toMatch(/engine\/index\.js/);
  }, 60_000);

  it('refuses another extension’s signed archive copied under a first-party name', async () => {
    const other = `u3other${STAMP}`;
    write(join(src, other), other);
    await installSigned(other, join(src, other));
    cpSync(join(base, other), join(base, BORROWED), { recursive: true });
    rmSync(join(base, other), { recursive: true, force: true });
    await load(BORROWED);
    expect(ran(BORROWED)).toBe(false);
    expect(extensionLoader.loaded.has(BORROWED)).toBe(false);
    expect(extensionLoader.getLastLoadError(BORROWED)).toMatch(/names .* not/);
  }, 60_000);
});
