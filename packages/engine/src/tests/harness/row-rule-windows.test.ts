/**
 * No committed state in which the database enforces row rules other than the
 * ones stored.
 *
 * The restrictive policy `zv_row_rules` is the database's copy of
 * `zvd_rls_policies`. It used to be rebuilt after the rule's COMMIT: a rule
 * written while its table was busy past the 2 s lock bound was answered with
 * success, stored, and stayed out of the database until the next boot — a new
 * rule hid nothing from raw SQL, a deleted one went on hiding rows.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SQL } from 'bun';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
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
const RULED = `hrowwin_${Date.now()}`;
const TABLE = `zvd_${RULED}`;

d('row rules reach the database with their commit', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  let memberId = '';

  /** Rows of the table the member reads as `zveltio_rls`, with the settings a request publishes. */
  const memberSees = () =>
    runOutsideTenantContext(() =>
      withTenantIsolation(
        DEFAULT_TENANT_ID,
        async (trx) =>
          (
            await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(TABLE)}`.execute(
              trx,
            )
          ).rows[0]!.n,
        {
          userId: memberId,
          identity: {
            userId: memberId,
            email: '',
            role: 'member',
            roles: ['member'],
            bypass: false,
            collectionAll: true,
          },
        },
      ),
    );

  const stored = async () =>
    (
      await sql<{
        id: string;
      }>`SELECT id FROM zvd_rls_policies WHERE collection = ${RULED}`.execute(db)
    ).rows[0]?.id;

  /** `fn` while another session holds a write lock on the table, past the 2 s bound. */
  const whileBusy = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    const other = new SQL(process.env.TEST_DATABASE_URL!);
    const held = await other.reserve();
    try {
      await held`BEGIN`;
      await held.unsafe(`LOCK TABLE "${TABLE}" IN ROW EXCLUSIVE MODE`);
      const out = await fn();
      await held`ROLLBACK`;
      return out;
    } finally {
      held.release();
      await other.close();
    }
  };

  const rule = {
    collection: RULED,
    role: 'member',
    filter_field: 'owner',
    filter_op: 'eq',
    filter_value_source: 'user_id',
  };
  const post = () =>
    app.request('/api/admin/rls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify(rule),
    });
  const del = (id: string) =>
    app.request(`/api/admin/rls/${id}`, { method: 'DELETE', headers: { cookie: god } });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    ({ userId: memberId } = await createMemberSession(app, db, {
      grants: [{ collection: RULED, actions: ['read'] }],
    }));
    await DDLManager.createCollection(db, {
      name: RULED,
      adoptRules: true,
      fields: [{ name: 'owner', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    await sql`
      INSERT INTO ${sql.table(TABLE)} (tenant_id, owner)
      VALUES (${DEFAULT_TENANT_ID}::uuid, ${memberId}), (${DEFAULT_TENANT_ID}::uuid, 'someone-else')`.execute(
      db,
    );
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zvd_rls_policies WHERE collection = ${RULED}`.execute(db).catch(() => {});
    await dropTestCollection(db, RULED).catch(() => {});
  });

  it('a rule written or deleted while the table is busy is enforced by the database, or not written', async () => {
    expect(await memberSees()).toBe(2);

    // Created on a busy table: refused, nothing stored, the database unchanged.
    const created = await whileBusy(post);
    expect({
      status: created.status,
      stored: !!(await stored()),
      sees: await memberSees(),
    }).toEqual({
      status: 503,
      stored: false,
      sees: 2,
    });

    // Uncontended, enforced the moment it is committed.
    expect((await post()).status).toBe(201);
    expect(await memberSees()).toBe(1);

    // Deleted on a busy table: refused, the rule and its policy both stay.
    const id = (await stored())!;
    const deleted = await whileBusy(() => del(id));
    expect({
      status: deleted.status,
      stored: !!(await stored()),
      sees: await memberSees(),
    }).toEqual({
      status: 503,
      stored: true,
      sees: 1,
    });

    // Uncontended, lifted the moment it is committed.
    expect((await del(id)).status).toBe(200);
    expect(await memberSees()).toBe(2);
  }, 20_000);
});
