/**
 * An extension migration blocked on a lock gives up instead of stalling the table.
 *
 * The engine's own runner opens each migration's transaction with
 * `SET LOCAL lock_timeout` (`applyMigration()` in `db/migrations/index.ts`).
 * The extension runner did not: an extension's ALTER behind one long-running
 * reader waited forever at the head of the lock queue, and every query
 * arriving on that table queued behind it — an install or enable from the
 * marketplace taking the table offline for as long as the reader lived.
 *
 * Driven through `runExtensionMigrations`, the function every load path runs
 * an extension's DDL through, against a real lock held on a second backend.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { runExtensionMigrations } from '../../lib/extensions/migration-runner.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const EXT = 'extlockprobe';
const TABLE = `zv_${EXT}_rows`;
const DIR = `${process.env.TMPDIR ?? '/tmp'}/zv-extlock-${Date.now()}`;

d('extension migrations: a lock wait is bounded by lock_timeout', () => {
  let db: Database;
  const prevTimeout = process.env.ZVELTIO_MIGRATION_LOCK_TIMEOUT;

  async function cleanup(): Promise<void> {
    await sql.raw(`DROP TABLE IF EXISTS ${TABLE}`).execute(db);
    await sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${EXT}:%`}`.execute(db);
  }

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await cleanup();
    await sql.raw(`CREATE TABLE ${TABLE} (id serial PRIMARY KEY)`).execute(db);
    await Bun.write(`${DIR}/001_add_label.sql`, `ALTER TABLE ${TABLE} ADD COLUMN label text;`);
    process.env.ZVELTIO_MIGRATION_LOCK_TIMEOUT = '300ms';
  }, 60_000);

  afterAll(async () => {
    if (prevTimeout === undefined) delete process.env.ZVELTIO_MIGRATION_LOCK_TIMEOUT;
    else process.env.ZVELTIO_MIGRATION_LOCK_TIMEOUT = prevTimeout;
    if (db) await cleanup().catch(() => undefined);
    await Bun.$`rm -rf ${DIR}`.quiet().nothrow();
  });

  it('fails with 55P03 while a reader holds the table, and nothing is recorded', async () => {
    const ext = {
      name: EXT,
      getMigrations: () => [`${DIR}/001_add_label.sql`],
    } as unknown as ZveltioExtension;

    // A reader on another backend: ACCESS SHARE, which the ALTER's ACCESS
    // EXCLUSIVE must wait for.
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => {
      locked = r;
    });
    const holder = db.transaction().execute(async (trx) => {
      await sql.raw(`SELECT * FROM ${TABLE}`).execute(trx);
      locked();
      await held;
    });

    try {
      await lockTaken;
      const outcome = await Promise.race([
        runExtensionMigrations(ext, db).then(
          () => 'applied' as const,
          (err: unknown) => err,
        ),
        Bun.sleep(5_000).then(() => 'hung' as const),
      ]);
      // 'hung' is the defect: no lock_timeout, so the ALTER waits for the reader.
      expect(outcome).not.toBe('hung');
      expect(outcome).not.toBe('applied');
      expect((outcome as { errno?: string }).errno).toBe('55P03');
    } finally {
      release();
      await holder;
    }

    const row = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zv_migrations WHERE name LIKE ${`ext:${EXT}:%`}
    `.execute(db);
    expect(row.rows[0].n).toBe(0);
  }, 30_000);

  it('applies once the reader is gone', async () => {
    const ext = {
      name: EXT,
      getMigrations: () => [`${DIR}/001_add_label.sql`],
    } as unknown as ZveltioExtension;
    await runExtensionMigrations(ext, db);
    const col = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_name = ${TABLE} AND column_name = 'label'
    `.execute(db);
    expect(col.rows[0].n).toBe(1);
  }, 30_000);
});
