/**
 * The boot reconcile used to learn extension resource names from one frozen
 * array in engine source — `KNOWN_EXTENSION_RESOURCES`, harvested by hand when
 * deny-by-default landed. Anything installed afterwards contributed nothing to
 * it, so keeping the reconcile correct meant editing the engine every time the
 * ecosystem grew.
 *
 * The declarations were already on disk the whole time: `manifest.resources` is
 * the field `register.ts` materializes from as each extension loads. These tests
 * pin that `listKnownResources` reads the same source, so the array is a floor
 * rather than the mechanism.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { createDb, type Database } from '../../db/index.js';
import { listKnownResources } from '../../lib/tenancy/resource-grants.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const EXT_NAME = `audit/sweeptest-${STAMP}`;
const NOVEL_RESOURCE = `sweeptest_resource_${STAMP}`;

d('listKnownResources reads manifest.resources (in-process)', () => {
  let db: Database;
  let extRoot: string;
  let savedDir: string | undefined;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    extRoot = mkdtempSync(join(tmpdir(), 'ext-resources-'));
    mkdirSync(join(extRoot, EXT_NAME), { recursive: true });
    writeFileSync(
      join(extRoot, EXT_NAME, 'manifest.json'),
      JSON.stringify({ name: EXT_NAME, resources: [NOVEL_RESOURCE] }),
    );
    // The directory is passed to `listKnownResources` explicitly — tenancy does
    // not resolve it, so that an import cycle stays closed. EXTENSIONS_DIR is
    // still set so anything else booting during the test agrees with us.
    savedDir = process.env.EXTENSIONS_DIR;
    process.env.EXTENSIONS_DIR = extRoot;
  });

  afterEach(async () => {
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT_NAME}`.execute(db);
  });

  afterAll(() => {
    if (savedDir === undefined) delete process.env.EXTENSIONS_DIR;
    else process.env.EXTENSIONS_DIR = savedDir;
    if (extRoot) rmSync(extRoot, { recursive: true, force: true });
  });

  it('picks up a resource no engine source has ever heard of', async () => {
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, version, is_installed, is_enabled)
      VALUES (${EXT_NAME}, 'Sweep Test', '1.0.0', true, false)
    `.execute(db);

    const known = await listKnownResources(db, extRoot);
    expect(known).toContain(NOVEL_RESOURCE);
  });

  it('ignores an extension that is recorded but not installed', async () => {
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, version, is_installed, is_enabled)
      VALUES (${EXT_NAME}, 'Sweep Test', '1.0.0', false, false)
    `.execute(db);

    const known = await listKnownResources(db, extRoot);
    expect(known).not.toContain(NOVEL_RESOURCE);
  });

  it('returns no extension resources at all when nothing is installed', async () => {
    // There used to be a frozen array of 28 names underneath this, and this test
    // asserted they always came back. It was removed on 2026-08-30 (owner
    // decision), so the floor is now exactly the collections — an extension that
    // declares nothing gets nothing, and says so at boot.
    const known = await listKnownResources(db, extRoot);
    expect(known).not.toContain(NOVEL_RESOURCE);
    const collections = await sql<{ name: string }>`SELECT name FROM zvd_collections`.execute(db);
    expect(known.sort()).toEqual([...new Set(collections.rows.map((r) => r.name))].sort());
  });

  it('names an installed extension that declares nothing', async () => {
    // The frozen list used to cover these silently. Removing it without saying
    // anything would turn "my extension stopped working after the upgrade" into
    // a deny-by-default refusal with nothing to point at, so the reconcile names
    // them at boot instead.
    const mute = `audit/mute-${STAMP}`;
    mkdirSync(join(extRoot, mute), { recursive: true });
    writeFileSync(join(extRoot, mute, 'manifest.json'), JSON.stringify({ name: mute }));
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, version, is_installed, is_enabled)
      VALUES (${mute}, 'Mute', '1.0.0', true, false)
    `.execute(db);

    const said: string[] = [];
    const warn = spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      said.push(a.map(String).join(' '));
    });
    try {
      await listKnownResources(db, extRoot);
    } finally {
      warn.mockRestore();
      await sql`DELETE FROM zv_extension_registry WHERE name = ${mute}`.execute(db);
      rmSync(join(extRoot, mute), { recursive: true, force: true });
    }
    const line = said.find((l) => l.includes('declare no'));
    expect(line).toBeDefined();
    expect(line).toContain(mute);
    expect(line).toContain('beta.63');
  });

  it('a manifest that is not valid JSON costs only its own resources', async () => {
    // One broken extension must not take the reconcile down for every other
    // resource on the instance — the catch exists for that, so it gets exercised.
    const brokenName = `audit/broken-json-${STAMP}`;
    mkdirSync(join(extRoot, brokenName), { recursive: true });
    writeFileSync(join(extRoot, brokenName, 'manifest.json'), '{ this is not json');
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, version, is_installed, is_enabled)
      VALUES (${brokenName}, 'Broken', '1.0.0', true, false)
    `.execute(db);
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, version, is_installed, is_enabled)
      VALUES (${EXT_NAME}, 'Sweep Test', '1.0.0', true, false)
    `.execute(db);
    try {
      const known = await listKnownResources(db, extRoot);
      // The good neighbour is still there.
      expect(known).toContain(NOVEL_RESOURCE);
    } finally {
      await sql`DELETE FROM zv_extension_registry WHERE name = ${brokenName}`.execute(db);
      rmSync(join(extRoot, brokenName), { recursive: true, force: true });
    }
  });

  it('a database without the registry table falls back instead of throwing', async () => {
    // Literally the case the catch documents: an install mid-upgrade, where
    // collections exist and `zv_extension_registry` does not yet. A reconcile
    // that threw here would take the boot with it, and the built-in floor still
    // covers it — so the failure is a warning, not a stop.
    const dbName = `zv_noreg_${STAMP}`;
    const admin = createDb('postgresql://postgres:postgres@localhost:5432/postgres');
    await sql.raw(`CREATE DATABASE "${dbName}"`).execute(admin);
    await admin.destroy();

    const partial = createDb(`postgresql://postgres:postgres@localhost:5432/${dbName}`);
    try {
      await sql.raw('CREATE TABLE zvd_collections (name TEXT PRIMARY KEY)').execute(partial);
      await sql.raw("INSERT INTO zvd_collections (name) VALUES ('widgets')").execute(partial);

      const known = await listKnownResources(partial, extRoot);

      // A missing registry costs the extension resources and nothing else: the
      // collections still come back, so deny-by-default does not close the whole
      // instance because one table was absent.
      expect(known).toContain('widgets');
      expect(known).not.toContain(NOVEL_RESOURCE);
    } finally {
      await partial.destroy();
      const cleanup = createDb('postgresql://postgres:postgres@localhost:5432/postgres');
      await sql.raw(`DROP DATABASE IF EXISTS "${dbName}"`).execute(cleanup);
      await cleanup.destroy();
    }
  }, 60_000);

  it('survives an extension whose manifest is missing or unreadable', async () => {
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, version, is_installed, is_enabled)
      VALUES (${`audit/no-manifest-${STAMP}`}, 'No Manifest', '1.0.0', true, false)
    `.execute(db);
    try {
      // Reads must not throw: one unreadable extension cannot be allowed to take
      // down the reconcile for every other resource on the instance.
      //
      // This used to assert `length > 0`, which the frozen list guaranteed for
      // free — so it proved nothing about the reading. With the list gone the
      // honest assertion is the one the test was named for: it returns, and it
      // returns a list.
      const known = await listKnownResources(db, extRoot);
      expect(Array.isArray(known)).toBe(true);
    } finally {
      await sql`DELETE FROM zv_extension_registry WHERE name = ${`audit/no-manifest-${STAMP}`}`.execute(
        db,
      );
    }
  });
});
