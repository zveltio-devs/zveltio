/**
 * `db.transaction()` on a handle that joins the request's transaction — core
 * routes' request-scoped db and an extension's `ctx.db` — honours the builder
 * options or refuses them; it no longer drops them.
 *
 * Measured on master: `setAccessMode('read only')` was ignored by both, so an
 * INSERT inside the "read-only" scope committed, and `setIsolationLevel(
 * 'serializable')` ran the work at the request's READ COMMITTED without a word.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { _resetExtensionDbRoleForTests } from '../../lib/extensions/ext-db-role.js';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { createRequestScopedDb, getCurrentTenantTrx } from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT = '00000000-0000-0000-0000-000000000001';
const TABLE = 'zv_joinopt_notes';

d('a joined db.transaction() honours its options', () => {
  let db: Database;
  const inTenant = <T>(fn: (trx: Database) => Promise<T>): Promise<T> =>
    buildExtensionInternals().withTenantIsolation(TENANT, () => fn(getCurrentTenantTrx()!));
  const insert = (h: Database) =>
    sql`INSERT INTO ${sql.table(TABLE)} (note) VALUES ('x')`.execute(h);
  const setting = async (h: Database, name: string) =>
    (await sql<{ v: string }>`SELECT current_setting(${name}) AS v`.execute(h)).rows[0]!.v;

  beforeAll(async () => {
    // The role ctx.db runs as is process state a file that loaded an extension
    // leaves on. This file builds ctx.db without load.ts' grant step, so it
    // tests the analyzer alone; extension-db-role.test.ts tests the role.
    _resetExtensionDbRoleForTests();
    db = (await getTestApp()).db;
    await sql`CREATE TABLE IF NOT EXISTS ${sql.table(TABLE)} (id serial PRIMARY KEY, note text)`.execute(
      db,
    );
  });
  afterAll(async () => {
    await sql`DROP TABLE IF EXISTS ${sql.table(TABLE)}`.execute(db);
  });

  const handles: [string, () => Database][] = [
    ['core request-scoped db', () => createRequestScopedDb(db)],
    ['extension ctx.db', () => createRestrictedDb(() => getCurrentTenantTrx() ?? db, 'joinopt')],
  ];

  for (const [name, make] of handles) {
    it(`${name}: setAccessMode('read only') is read-only for the scope only`, async () => {
      const h = make();
      await inTenant(async (trx) => {
        await expect(
          h
            .transaction()
            .setAccessMode('read only')
            .execute((t) => insert(t)),
        ).rejects.toThrow(/read-only transaction/);
        expect(
          await h
            .transaction()
            .setAccessMode('read only')
            .execute((t) => setting(t, 'transaction_read_only')),
        ).toBe('on');
        expect(await setting(trx, 'transaction_read_only')).toBe('off');
        await insert(h);
      });
    }, 60_000);

    it(`${name}: setIsolationLevel must name the running transaction's level`, async () => {
      const h = make();
      await inTenant(async (trx) => {
        const running = await setting(trx, 'transaction_isolation');
        expect(running).not.toBe('serializable');
        await expect(
          h
            .transaction()
            .setIsolationLevel('serializable')
            .execute((t) => insert(t)),
        ).rejects.toThrow(/cannot change the isolation level/);
        expect(
          await h
            .transaction()
            .setIsolationLevel(running as 'read committed')
            .execute(async () => 'ran'),
        ).toBe('ran');
      });
    }, 60_000);
  }
});
