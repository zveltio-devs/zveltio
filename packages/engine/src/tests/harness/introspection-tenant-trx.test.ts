/**
 * `introspectSchema` registers collections from inside a request's tenant
 * transaction, as `developer/byod` calls it (`ctx.internals.introspectSchema`
 * with its `ctx.db` transaction).
 *
 * Measured on master: there the role is `zveltio_rls`, which reads
 * `zvd_collections` and writes none of it, so every import answered
 * `permission denied for table zvd_collections`. And an import whose table was
 * named like a managed collection rewrote that collection's `fields`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/ddl-manager.js';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { introspectSchema } from '../../lib/introspection.js';
import { DEFAULT_TENANT_ID, withTenantIsolation } from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const SCHEMA = `intro_src_${STAMP}`;
const FRESH = `intro_new_${STAMP}`;
const MANAGED = `intro_managed_${STAMP}`;

d('introspectSchema inside a tenant transaction', () => {
  let db: Database;
  beforeAll(async () => {
    ({ db } = await getTestApp());
    for (const q of [
      `CREATE SCHEMA ${SCHEMA}`,
      `CREATE TABLE ${SCHEMA}.${FRESH} (id uuid PRIMARY KEY, name text)`,
      `CREATE TABLE ${SCHEMA}.${MANAGED} (id uuid PRIMARY KEY, foreign_col text)`,
      // `information_schema` lists only what the request role may use.
      `GRANT USAGE ON SCHEMA ${SCHEMA} TO zveltio_rls`,
      `GRANT SELECT ON ALL TABLES IN SCHEMA ${SCHEMA} TO zveltio_rls`,
    ]) {
      await sql.raw(q).execute(db);
    }
    await sql`INSERT INTO zvd_collections (name, display_name, fields, is_managed)
              VALUES (${MANAGED}, ${MANAGED}, '[{"name":"kept","type":"text"}]'::jsonb, true)`.execute(
      db,
    );
  }, 120_000);

  afterAll(async () => {
    await sql`DELETE FROM zvd_collections WHERE name IN (${FRESH}, ${MANAGED})`.execute(db);
    await sql.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).execute(db);
    DDLManager.invalidateCache();
  });

  it('registers the new table as the engine, leaves the managed one alone, and refreshes the cache', async () => {
    // Cached absent before the import, as any earlier read would leave it.
    expect(await DDLManager.getCollection(db, FRESH)).toBeNull();

    const result = await withTenantIsolation(DEFAULT_TENANT_ID, async (trx) => {
      const role = (await sql<{ r: string }>`SELECT current_setting('role') AS r`.execute(trx))
        .rows[0]!.r;
      expect(role).toBe('zveltio_rls');
      // An extension's `ctx.db` over the request transaction, savepoint included.
      const ext = createRestrictedDb(trx, 'intro-probe', new Set());
      return ext.transaction().execute((t) => introspectSchema(t as Database, SCHEMA, [], false));
    });

    expect(result).toEqual([
      { tableName: FRESH, collectionName: FRESH, fieldsCount: 2, isNew: true },
    ]);
    const managed = await sql<{ fields: unknown }>`
      SELECT fields FROM zvd_collections WHERE name = ${MANAGED}`.execute(db);
    expect(managed.rows[0]!.fields).toEqual([{ name: 'kept', type: 'text' }]);
    expect((await DDLManager.getCollection(db, FRESH))?.is_managed).toBe(false);
  });

  it('serves the collection from a view with the request role\'s own rights, and a drop keeps the source', async () => {
    const id = crypto.randomUUID();
    // The view lends nothing: with SELECT only on the source, the request role cannot write.
    const refused = await withTenantIsolation(DEFAULT_TENANT_ID, async (trx) =>
      sql`INSERT INTO ${sql.id('public', `zvd_${FRESH}`)} (id, name) VALUES (${id}, 'x')`
        .execute(trx)
        .then(
          () => null,
          (e: Error) => e.message,
        ),
    ).catch((e: Error) => e.message);
    expect(refused).toContain('permission denied');

    await sql.raw(`GRANT INSERT ON ${SCHEMA}.${FRESH} TO zveltio_rls`).execute(db);
    await withTenantIsolation(DEFAULT_TENANT_ID, async (trx) => {
      await sql`INSERT INTO ${sql.id('public', `zvd_${FRESH}`)} (id, name) VALUES (${id}, 'x')`.execute(
        trx,
      );
      const read = await sql<{ name: string }>`
        SELECT name FROM ${sql.id('public', `zvd_${FRESH}`)} WHERE id = ${id}`.execute(trx);
      expect(read.rows).toEqual([{ name: 'x' }]);
    });
    expect(await DDLManager.tableExists(db, FRESH)).toBe(true);

    await DDLManager.dropInTransaction(db, FRESH, {});
    expect(await DDLManager.tableExists(db, FRESH)).toBe(false);
    const source = await sql<{ name: string }>`
      SELECT name FROM ${sql.id(SCHEMA, FRESH)} WHERE id = ${id}`.execute(db);
    expect(source.rows).toEqual([{ name: 'x' }]);
  });
});
