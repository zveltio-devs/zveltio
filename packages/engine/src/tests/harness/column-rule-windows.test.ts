/**
 * L37 — no committed state in which the database enforces column rules older
 * than the ones stored.
 *
 * The write guard (072) and the masking view + seal (073/075) are the database's
 * copy of `zvd_column_permissions`. They used to be rebuilt after the COMMIT that
 * changed the rules: a rule committed while the table was busy past the 2 s lock
 * bound stayed out of the database until the next boot, and a renamed field was
 * written under its new name past a guard that still named the old one. A Ghost
 * DDL copy was readable by the request role, every tenant and every password
 * hash on it, for as long as the copy ran.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SQL } from 'bun';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { alterField } from '../../lib/data/field-changes.js';
import {
  cancelPendingCleanups,
  DDLManager,
  GhostDDL,
  sweepGhostOrphans,
} from '../../lib/data/index.js';
import { DEFAULT_TENANT_ID } from '../../lib/route-db.js';
import { runOutsideTenantContext, withTenantIsolation } from '../../lib/tenancy/index.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const RULED = `hcolwin_${STAMP}`;
const RENAMED = `hcolwinr_${STAMP}`;
const GHOSTED = `hcolwing_${STAMP}`;

const text = (name: string) => ({
  name,
  type: 'text',
  required: false,
  unique: false,
  indexed: false,
});

d('column rules reach the database with their commit (L37)', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  let memberId = '';

  /** A statement as the member, on `zveltio_rls`, with the settings a request publishes. */
  const asMember = <T>(fn: (trx: Database) => Promise<T>) =>
    runOutsideTenantContext(() =>
      withTenantIsolation(DEFAULT_TENANT_ID, fn, {
        userId: memberId,
        identity: {
          userId: memberId,
          email: '',
          role: 'member',
          roles: ['member'],
          bypass: false,
          collectionAll: true,
        },
      }),
    );

  const refused = (p: Promise<unknown>) =>
    p.then(
      () => false,
      (err: { errno?: string }) => err.errno === '42501',
    );

  const insertRow = async (table: string, values: string) =>
    (
      await sql<{ id: string }>`
        INSERT INTO ${sql.table(table)} (tenant_id, ${sql.raw(values)})
        VALUES (${DEFAULT_TENANT_ID}::uuid, 'seed') RETURNING id::text AS id`.execute(db)
    ).rows[0]!.id;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    ({ userId: memberId } = await createMemberSession(app, db, {
      grants: [RULED, RENAMED, GHOSTED].map((collection) => ({
        collection,
        actions: ['read', 'create', 'update', 'delete'],
      })),
    }));
    for (const [name, fields] of [
      [RULED, [text('title'), text('secret')]],
      [RENAMED, [text('title'), text('secret')]],
      [GHOSTED, [text('title'), { ...text('pw'), type: 'password' }]],
    ] as const) {
      await DDLManager.createCollection(db, { name, adoptRules: true, fields } as never);
    }
  });

  afterAll(async () => {
    if (!db) return;
    cancelPendingCleanups();
    await db
      .deleteFrom('zvd_column_permissions')
      .where('collection_name', 'in', [RULED, RENAMED])
      .execute()
      .catch(() => {});
    const ghosted = `zvd_${GHOSTED}`;
    for (const t of [`_zv_ghost_${ghosted}`, `_zv_changelog_${ghosted}`]) {
      await sql`DROP TABLE IF EXISTS ${sql.id(t)} CASCADE`.execute(db).catch(() => {});
    }
    await sweepGhostOrphans(db).catch(() => {});
    for (const c of [RULED, RENAMED, GHOSTED]) await dropTestCollection(db, c).catch(() => {});
  });

  it('a rule written while the table is busy is enforced by the database, or not written', async () => {
    const table = `zvd_${RULED}`;
    const id = await insertRow(table, 'secret');
    // Another session's open write transaction: the guard's rebuild waits on it
    // past the 2 s bound.
    const other = new SQL(process.env.TEST_DATABASE_URL!);
    const held = await other.reserve();
    try {
      await held`BEGIN`;
      await held.unsafe(`LOCK TABLE "${table}" IN ROW EXCLUSIVE MODE`);
      const res = await app.request('/api/admin/column-permissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: god },
        body: JSON.stringify({
          collection_name: RULED,
          column_name: 'secret',
          role: 'member',
          can_read: true,
          can_write: false,
        }),
      });
      await held`ROLLBACK`;
      const stored = await db
        .selectFrom('zvd_column_permissions')
        .select('id')
        .where('collection_name', '=', RULED)
        .executeTakeFirst();
      const forged = !(await refused(
        asMember((trx) =>
          sql`UPDATE ${sql.table(table)} SET secret = 'forged' WHERE id = ${id}`.execute(trx),
        ),
      ));
      // Never a committed rule the database does not enforce: the change fails.
      expect({ status: res.status, stored: !!stored, forged }).toEqual({
        status: 503,
        stored: false,
        forged: true,
      });
    } finally {
      held.release();
      await other.close();
    }

    // Uncontended, the same rule is enforced the moment it is committed.
    const ok = await app.request('/api/admin/column-permissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({
        collection_name: RULED,
        column_name: 'secret',
        role: 'member',
        can_read: true,
        can_write: false,
      }),
    });
    expect(ok.status).toBe(201);
    expect(
      await refused(
        asMember((trx) =>
          sql`UPDATE ${sql.table(table)} SET secret = 'forged again' WHERE id = ${id}`.execute(trx),
        ),
      ),
    ).toBe(true);
  });

  it('a renamed read-only field is guarded under its new name when the rename commits', async () => {
    const table = `zvd_${RENAMED}`;
    const id = await insertRow(table, 'secret');
    await db
      .insertInto('zvd_column_permissions')
      .values({
        collection_name: RENAMED,
        column_name: 'secret',
        role: 'member',
        can_read: true,
        can_write: false,
      })
      .execute();
    const { invalidateColumnPermCache } = await import('../../lib/tenancy/index.js');
    await invalidateColumnPermCache(RENAMED);

    // Renamed from inside a request's transaction (schema apply does this): the
    // after-commit refresh waits for that request, the rename has committed.
    const forged = await withTenantIsolation(DEFAULT_TENANT_ID, async () => {
      await alterField(db, RENAMED, 'secret', { newName: 'secret2' });
      return asMember((trx) =>
        sql`UPDATE ${sql.table(table)} SET secret2 = 'forged' WHERE id = ${id}`.execute(trx),
      ).then(
        () => true,
        () => false,
      );
    });
    expect(forged).toBe(false);
  });

  it('a Ghost DDL copy is readable by no request role while it is built', async () => {
    const table = `zvd_${GHOSTED}`;
    await sql`
      INSERT INTO ${sql.table(table)} (tenant_id, title, pw)
      VALUES (${DEFAULT_TENANT_ID}::uuid, 't', 'hash-of-a-password')`.execute(db);
    const migration = await GhostDDL.createGhost(db, table, [
      { kind: 'add_column', field: { name: 'pin', type: 'password' } as never },
    ]);
    expect(await GhostDDL.batchCopy(db, migration)).toBe(1);
    const read = await asMember((trx) =>
      sql<{ pw: string }>`SELECT pw FROM ${sql.table(migration.ghostTable)}`.execute(trx),
    ).then(
      (r) => r.rows.map((x) => x.pw),
      (err: { errno?: string }) => err.errno,
    );
    expect(read).toBe('42501');
    const grants = await sql<{ role: string; ok: boolean }>`
      SELECT rolname AS role, has_any_column_privilege(oid, ${migration.ghostTable}::regclass, 'SELECT') AS ok
        FROM pg_roles
       WHERE rolname IN ('zveltio_rls', 'zveltio_worker', 'zveltio_flow_reader', 'zveltio_ext')`.execute(
      db,
    );
    expect(grants.rows.filter((r) => r.ok)).toEqual([]);
  });
});
