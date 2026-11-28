/**
 * ADR 0053 decision 5 (DR-47): an action may list `"*"` in `reads` / `writes`
 * only in a first-party extension — the publisher tier `enforcePublisherTier`
 * verifies, never the name. Since ADR 0062 d1 every extension off the engine's
 * inline list runs as a worker, so on the runner (d2) the tier comes from the
 * signature: a registry signature whose catalogue tier is first-party is level
 * 0 and loads, as a worker; an operator key (level 3) or a registry signature of
 * any other tier (level 2) is refused at load, before anything of it exists.
 *
 * All go through the engine's own loader, from a directory on disk.
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
const FIRST_PARTY = `starfp${STAMP}`;
const LEVEL2 = `starl2${STAMP}`;

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

  /** No `engine.isolation`: the manifest does not choose where it runs (ADR 0062 d1). */
  function write(name: string, reads: string[], migration: boolean): void {
    const dir = join(base, name);
    mkdirSync(join(dir, 'engine', 'migrations'), { recursive: true });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        resources: [name],
        engine: { entry: 'engine/index.js', bundled: true },
        actions: [{ name: 'peek', permission: { resource: name }, input: {}, reads }],
      }),
    );
    writeFileSync(join(dir, 'engine', 'index.js'), entry(name));
    if (migration) {
      writeFileSync(
        join(dir, 'engine', 'migrations', '001_items.sql'),
        `CREATE TABLE IF NOT EXISTS zv_${name}_items (id serial PRIMARY KEY);\n` +
          `-- DOWN\nDROP TABLE IF EXISTS zv_${name}_items;\n`,
      );
    }
  }
  /** Signed as a registry download leaves it, with this run's key on REGISTRY_PUBLIC_KEYS_JSON. */
  function signAsRegistry(name: string): void {
    const signed = Bun.spawnSync(['bun', SIGN, base, name]);
    expect(signed.exitCode).toBe(0);
    process.env.REGISTRY_PUBLIC_KEYS_JSON = signed.stdout
      .toString()
      .trim()
      .replace(/^REGISTRY_PUBLIC_KEYS_JSON=/, '');
  }
  /** Load `name` with the catalogue saying `tier` of it: what a registry signature binds. */
  async function loadWithTier(name: string, tier: string): Promise<void> {
    const spy = spyOn(extensionDownload, 'fetchRegistryCatalog').mockResolvedValue([
      { name, publisher_tier: tier } as never,
    ]);
    try {
      await extensionLoader.loadExtension(name, app, ctx(), base);
    } finally {
      spy.mockRestore();
    }
  }
  const keys = process.env.REGISTRY_PUBLIC_KEYS_JSON;
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
    if (keys === undefined) delete process.env.REGISTRY_PUBLIC_KEYS_JSON;
    else process.env.REGISTRY_PUBLIC_KEYS_JSON = keys;
    for (const name of [WORKER, FIRST_PARTY, LEVEL2]) {
      await extensionLoader.unload(name).catch(() => {});
      await sql`DROP TABLE IF EXISTS ${sql.table(`zv_${name}_items`)}`.execute(db);
      await sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${name}:%`}`.execute(db);
      await revokeExtensionDbRoles(db, name, true).catch(() => {});
      await forgetInstalled(db, name);
    }
    rmSync(base, { recursive: true, force: true });
  });

  it('refuses an operator-signed extension listing "*" (level 3)', async () => {
    write(WORKER, ['*'], true);
    // An operator key: level 3, never first-party (ADR 0056 d1).
    await signAsOperator(join(base, WORKER), WORKER);
    await markInstalled(db, WORKER);
    wasInline = _setInlineForTests(false);
    await loadWithTier(WORKER, 'first-party');
    expect(extensionLoader.loaded.has(WORKER)).toBe(false);
    // At the tier gate, before its migrations: nothing of it was created.
    expect(await exists(OWN)).toBe(false);
    expect(extensionLoader.getLastLoadError(WORKER)).toMatch(
      /operator key .*\(level 3\).*action "peek" lists "\*".*first-party/,
    );
  }, 60_000);

  it('refuses a registry-signed extension of another tier listing "*" (level 2)', async () => {
    write(LEVEL2, ['*'], false);
    signAsRegistry(LEVEL2);
    await markInstalled(db, LEVEL2);
    wasInline = _setInlineForTests(false);
    await loadWithTier(LEVEL2, 'verified');
    expect(extensionLoader.loaded.has(LEVEL2)).toBe(false);
    expect(extensionLoader.getLastLoadError(LEVEL2)).toMatch(
      /no verified first-party tier.*action "peek" lists "\*"/,
    );
  }, 60_000);

  it('loads a first-party extension listing "*" as a worker: level 0, from the signature (ADR 0062 d2)', async () => {
    write(FIRST_PARTY, ['*'], false);
    signAsRegistry(FIRST_PARTY);
    await markInstalled(db, FIRST_PARTY);
    wasInline = _setInlineForTests(false);
    await loadWithTier(FIRST_PARTY, 'first-party');
    expect(extensionLoader.getLastLoadError(FIRST_PARTY)).toBeUndefined();
    expect(extensionLoader.loaded.has(FIRST_PARTY)).toBe(true);
    // On the runner, not in the engine: its process runs, and knows its tier.
    const host = getWorkerHost(app);
    expect(host.isRunning(FIRST_PARTY)).toBe(true);
    expect(host.getHealth().find((h) => h.name === FIRST_PARTY)?.level).toBe(0);
  }, 60_000);
});
