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

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { createDb, type Database } from '../../db/index.js';
import {
  KNOWN_EXTENSION_RESOURCES,
  listKnownResources,
} from '../../lib/tenancy/resource-grants.js';
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
    expect(KNOWN_EXTENSION_RESOURCES).not.toContain(NOVEL_RESOURCE);

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

  it('still returns the built-in floor when nothing is installed', async () => {
    const known = await listKnownResources(db, extRoot);
    for (const resource of KNOWN_EXTENSION_RESOURCES) {
      expect(known).toContain(resource);
    }
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
      // And the built-in floor survived too.
      expect(known).toContain(KNOWN_EXTENSION_RESOURCES[0]);
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

      expect(known).toContain('widgets');
      // The floor survived the missing registry.
      expect(known).toContain(KNOWN_EXTENSION_RESOURCES[0]);
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
      const known = await listKnownResources(db, extRoot);
      expect(known.length).toBeGreaterThan(0);
    } finally {
      await sql`DELETE FROM zv_extension_registry WHERE name = ${`audit/no-manifest-${STAMP}`}`.execute(
        db,
      );
    }
  });
});
