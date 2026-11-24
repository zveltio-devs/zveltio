/**
 * ADR 0053 decision 5 (DR-47): an action may list `"*"` in `reads` / `writes`
 * only in a first-party extension — the publisher tier `enforcePublisherTier`
 * verifies, never the name. A worker-isolated extension's tier is never looked
 * up, so it is never proven first-party: it is refused at load, even under the
 * test-only inline override. A first-party one (inline) still loads.
 *
 * Both go through the engine's own loader, from a directory on disk.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { revokeExtensionDbRoles } from '../../lib/extensions/ext-db-role.js';
import * as extensionDownload from '../../lib/extensions/extension-download.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import { _resetWorkerHostForTests, getWorkerHost } from '../../lib/worker-extension-host.js';
import {
  forgetInstalled,
  getTestApp,
  harnessAvailable,
  markInstalled,
} from '../../testing/app-harness.js';
import { signAsOperator } from '../../testing/operator-signed.js';

const SIGN = join(import.meta.dir, '../../../../../scripts/sign-as-registry.ts');

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = String(Date.now()).slice(-7);
const WORKER = `starwkr${STAMP}`;
const INLINE = `starfp${STAMP}`;

/** The worker extension's migration: refused before it runs, it never exists. */
const OWN = `zv_${WORKER}_items`;

const entry = (name: string) =>
  `export default { name: '${name}', mountStrategy: 'subapp', ` +
  `actions: { peek: async () => ({}) }, async register() {} };\n`;

d('"*" in an action is first-party only (ADR 0053 d5)', () => {
  let db: Database;
  let base: string;
  const app = new Hono();
  let wasInline = false;

  function write(name: string, isolation: 'worker' | undefined, reads: string[]): void {
    const dir = join(base, name);
    mkdirSync(join(dir, 'engine', 'migrations'), { recursive: true });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        resources: [name],
        engine: { entry: 'engine/index.js', bundled: true, ...(isolation ? { isolation } : {}) },
        actions: [{ name: 'peek', permission: { resource: name }, input: {}, reads }],
      }),
    );
    writeFileSync(join(dir, 'engine', 'index.js'), entry(name));
    writeFileSync(
      join(dir, 'engine', 'migrations', '001_items.sql'),
      `CREATE TABLE IF NOT EXISTS zv_${name}_items (id serial PRIMARY KEY);\n` +
        `-- DOWN\nDROP TABLE IF EXISTS zv_${name}_items;\n`,
    );
  }
  const exists = async (table: string) =>
    (await sql<{ t: string | null }>`SELECT to_regclass(${table})::text AS t`.execute(db)).rows[0]!
      .t !== null;
  const ctx = () => extensionLoader.ctx ?? ({ db, fieldTypeRegistry: { register() {} } } as never);

  beforeAll(async () => {
    db = (await getTestApp()).db;
    base = mkdtempSync(join(tmpdir(), 'star-fp-'));
    _resetWorkerHostForTests();
    getWorkerHost(app);
  });

  afterEach(() => {
    _setInlineForTests(wasInline);
    extensionDownload._resetCatalogCacheForTests();
  });

  afterAll(async () => {
    await getWorkerHost(app).stopAll();
    _resetWorkerHostForTests();
    for (const name of [WORKER, INLINE]) {
      await extensionLoader.unload(name).catch(() => {});
      await sql`DROP TABLE IF EXISTS ${sql.table(`zv_${name}_items`)}`.execute(db);
      await sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${name}:%`}`.execute(db);
      await revokeExtensionDbRoles(db, name, true).catch(() => {});
      await forgetInstalled(db, name);
    }
    rmSync(base, { recursive: true, force: true });
  });

  it('refuses a worker-isolated extension listing "*", signed as it must be to load', async () => {
    write(WORKER, 'worker', ['*']);
    // An operator key: level 3, never first-party (ADR 0056 d1).
    await signAsOperator(join(base, WORKER), WORKER);
    await markInstalled(db, WORKER);
    await extensionLoader.loadExtension(WORKER, app, ctx(), base);
    expect(extensionLoader.loaded.has(WORKER)).toBe(false);
    // At the tier gate, before its migrations: nothing of it was created.
    expect(await exists(OWN)).toBe(false);
    expect(extensionLoader.getLastLoadError(WORKER)).toMatch(
      /action "peek" lists "\*".*first-party/,
    );
  }, 60_000);

  it('loads a first-party extension listing "*" (tier from the catalog, not the name)', async () => {
    write(INLINE, undefined, ['*']);
    await markInstalled(db, INLINE);
    wasInline = _setInlineForTests(false);
    // Inline needs the registry's signature, in every NODE_ENV (ADR 0056
    // amendment 2026-11-21): signed as a download leaves it, with a run key.
    const signed = Bun.spawnSync(['bun', SIGN, base, INLINE]);
    expect(signed.exitCode).toBe(0);
    const keys = process.env.REGISTRY_PUBLIC_KEYS_JSON;
    process.env.REGISTRY_PUBLIC_KEYS_JSON = signed.stdout
      .toString()
      .trim()
      .replace(/^REGISTRY_PUBLIC_KEYS_JSON=/, '');
    const spy = spyOn(extensionDownload, 'fetchRegistryCatalog').mockResolvedValue([
      { name: INLINE, publisher_tier: 'first-party' } as never,
    ]);
    try {
      await extensionLoader.loadExtension(INLINE, app, ctx(), base);
    } finally {
      spy.mockRestore();
      if (keys === undefined) delete process.env.REGISTRY_PUBLIC_KEYS_JSON;
      else process.env.REGISTRY_PUBLIC_KEYS_JSON = keys;
    }
    expect(extensionLoader.getLastLoadError(INLINE)).toBeUndefined();
    expect(extensionLoader.loaded.has(INLINE)).toBe(true);
  }, 60_000);
});
