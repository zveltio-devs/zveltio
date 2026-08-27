/**
 * A database whose migration chain no longer matches the binary must stop the
 * engine, not boot quietly.
 *
 * Reproduced before the fix, on a database built by the real v3.0.0-beta.62
 * chain and then handed to a binary compiled from HEAD: `zveltio migrate`
 * printed two warnings, said "✅ Migrations complete", and exited 0 with
 * NOTHING applied. `POST /admin/migrate` has the same shape. Engine boot was
 * already refusing that case — but through `checkSchemaCompatibility`, on the
 * version number, telling the operator to "update to the latest version" when
 * they were already on it.
 *
 * Two independent holes, so both are covered here:
 *   1. `applyMigration` keyed on the version NUMBER, so a number reused by a
 *      different file counted as "already applied".
 *   2. `autoMigrate` short-circuits on `lastApplied >= MAX_SCHEMA_VERSION`,
 *      which reads a squashed database (46 recorded, 2 shipped) as "you are
 *      ahead of me, nothing to do" — returning before (1) is ever consulted.
 *      The same comparison is why a divergence at or BELOW that number — an
 *      applied file edited in place — was never noticed at all.
 *
 * Requires TEST_DATABASE_URL.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { sql } from 'kysely';
import { createDb } from '../../db/index.js';
import type { Database } from '../../db/index.js';
import { assertChainCompatible } from '../../db/migrations/index.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const skipAll = !TEST_DB_URL;

let db: Database;
/** The row we tamper with, restored after each case. */
let original: { version: number; filename: string; checksum: string } | undefined;

describe.skipIf(skipAll)('migration chain divergence fails closed', () => {
  beforeAll(async () => {
    db = createDb(TEST_DB_URL as string);
    const row = await sql<{
      version: number;
      filename: string;
      checksum: string;
    }>`SELECT version, filename, checksum FROM zv_schema_versions ORDER BY version DESC LIMIT 1`.execute(
      db,
    );
    original = row.rows[0];
  });

  // Each case tampers with the same row; restore it first, or the second case
  // inherits the first one's filename and the assertions drift onto the wrong
  // branch of the message.
  beforeEach(async () => {
    if (original) {
      await sql`UPDATE zv_schema_versions SET filename = ${original.filename},
                checksum = ${original.checksum} WHERE version = ${original.version}`.execute(db);
    }
  });

  afterAll(async () => {
    if (original) {
      await sql`UPDATE zv_schema_versions SET filename = ${original.filename},
                checksum = ${original.checksum} WHERE version = ${original.version}`.execute(db);
    }
    await db.destroy();
  });

  it('accepts a database whose recorded chain matches the shipped files', async () => {
    expect(assertChainCompatible(db)).resolves.toBeUndefined();
  });

  it('refuses when a number was reused by a different file (the squash case)', async () => {
    // What a beta.62 database looks like to a post-squash build: version 2 is
    // recorded, so it counts as applied, but it is a different migration.
    await sql`UPDATE zv_schema_versions SET filename = '002_something_else.sql',
              checksum = 'deadbeefdeadbeef' WHERE version = ${original?.version}`.execute(db);

    let err: Error | undefined;
    await assertChainCompatible(db).catch((e) => {
      err = e as Error;
    });
    expect(err).toBeDefined();
    // The message must name BOTH files — the old warning named neither, so an
    // operator could not tell which of the two causes they were looking at.
    expect(err?.message).toContain('002_something_else.sql');
    expect(err?.message).toContain('renumbered or squashed');
  });

  it('refuses when an applied file was edited in place', async () => {
    await sql`UPDATE zv_schema_versions SET checksum = 'deadbeefdeadbeef'
              WHERE version = ${original?.version}`.execute(db);

    let err: Error | undefined;
    await assertChainCompatible(db).catch((e) => {
      err = e as Error;
    });
    expect(err?.message).toContain('edited after it was applied');
  });

  it('lets an operator through with the escape hatch, loudly', async () => {
    await sql`UPDATE zv_schema_versions SET checksum = 'deadbeefdeadbeef'
              WHERE version = ${original?.version}`.execute(db);

    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(' '));
    };
    process.env.ZVELTIO_ALLOW_MIGRATION_DIVERGENCE = '1';
    try {
      await assertChainCompatible(db); // must not throw
    } finally {
      process.env.ZVELTIO_ALLOW_MIGRATION_DIVERGENCE = undefined;
      console.warn = realWarn;
    }
    expect(warnings.join('\n')).toContain('Overridden by ZVELTIO_ALLOW_MIGRATION_DIVERGENCE=1');
  });

  it('treats a baseline row as compatible — that is what a squash marks', async () => {
    await sql`UPDATE zv_schema_versions SET checksum = 'baseline'
              WHERE version = ${original?.version}`.execute(db);
    expect(assertChainCompatible(db)).resolves.toBeUndefined();
  });
});
