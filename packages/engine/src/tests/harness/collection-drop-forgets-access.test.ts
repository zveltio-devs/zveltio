/**
 * Dropping a collection takes its access rules with it — on every path that
 * drops one.
 *
 * `dropCollection` used to remove the table, `zvd_relations` and the
 * `zvd_collections` row and nothing else. Every Casbin grant on the resource (in
 * every tenant domain), every row rule, column permission and validation rule
 * stayed behind, keyed by name — so a collection created again under the same
 * name inherited all of them: a tenant grant made on the old collection read the
 * new one.
 *
 * Three callers: `DELETE /api/collections/:name` and schema apply / extensions
 * (the pool: `/api/collections` opens no request transaction), and the DDL queue
 * job (its own transaction). Each is driven the way it runs in production.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  enqueueDDLJob,
  initDDLQueue,
  isDDLQueueStarted,
  stopDDLQueue,
} from '../../lib/data/ddl-queue.js';
import { checkPermission, getEnforcer, reconcilePolicies } from '../../lib/tenancy/index.js';
import { runWithDomain } from '../../lib/tenancy/tenant-context.js';
import {
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT = '00000000-0000-0000-0000-000000000001';
const tag = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const SUBJECT = `drop-u-${tag}`;
const OTHER_TENANT = crypto.randomUUID();
const fields = [
  { name: 'title', type: 'text', required: false, unique: false, indexed: false },
] as never;

d('dropping a collection forgets its access rules', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  const names: string[] = [];

  const count = async (table: string, column: string, name: string) =>
    Number(
      (
        await sql<{ n: string }>`SELECT count(*)::text AS n FROM ${sql.table(table)}
                                 WHERE ${sql.ref(column)} = ${name}`.execute(db)
      ).rows[0]?.n,
    );
  const subjectRows = async (name: string) =>
    Number(
      (
        await sql<{ n: string }>`SELECT count(*)::text AS n FROM zvd_permissions
                                 WHERE ptype = 'p' AND v2 = ${name} AND v0 = ${SUBJECT}`.execute(db)
      ).rows[0]?.n,
    );
  const canRead = (name: string) =>
    runWithDomain(TENANT, () => checkPermission(SUBJECT, name, 'read'));

  /** A collection carrying one of everything that is keyed by its name. */
  async function seed(name: string) {
    names.push(name);
    await DDLManager.createCollection(db, { name, fields });
    await (await getEnforcer()).addPolicy(SUBJECT, TENANT, name, 'read');
    await sql`INSERT INTO zvd_rls_policies (collection, role, filter_field, filter_value_source)
              VALUES (${name}, 'tenant_member', 'title', 'user.id')`.execute(db);
    await sql`INSERT INTO zvd_column_permissions (collection_name, column_name, role, can_read)
              VALUES (${name}, 'title', 'tenant_member', false)`.execute(db);
    await sql`INSERT INTO zv_validation_rules (collection, field_name, rule_type, error_message)
              VALUES (${name}, 'title', 'required', 'needed')`.execute(db);
    expect(await canRead(name)).toBe(true);
  }

  /** Same name again: nothing of the old collection may reach the new one. */
  async function expectForgotten(name: string) {
    expect(await DDLManager.tableExists(db, name)).toBe(false);
    await DDLManager.createCollection(db, { name, fields });

    expect(await canRead(name)).toBe(false);
    expect(await (await getEnforcer()).hasPolicy(SUBJECT, TENANT, name, 'read')).toBe(false);
    expect(
      Number(
        (
          await sql<{ n: string }>`SELECT count(*)::text AS n FROM zvd_permissions
                                   WHERE v2 = ${name} AND v0 = ${SUBJECT}`.execute(db)
        ).rows[0]?.n,
      ),
    ).toBe(0);
    expect(await count('zvd_rls_policies', 'collection', name)).toBe(0);
    expect(await count('zvd_column_permissions', 'collection_name', name)).toBe(0);
    expect(await count('zv_validation_rules', 'collection', name)).toBe(0);

    // The default grants a new collection gets are written again, in the
    // table and in the live model, after the old ones were taken away.
    const rule = ['tenant_member', '*', name, 'read'];
    expect((await getEnforcer()).getModel().hasPolicy('p', 'p', rule)).toBe(true);
    expect(
      Number(
        (
          await sql<{ n: string }>`SELECT count(*)::text AS n FROM zvd_permissions
                                   WHERE ptype = 'p' AND v0 = 'tenant_member' AND v1 = '*'
                                     AND v2 = ${name} AND v3 = 'read'`.execute(db)
        ).rows[0]?.n,
      ),
    ).toBe(1);
  }

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await reconcilePolicies();
  });

  // CI runs every harness file in one process: stop only a queue this file
  // started, or every later test that enqueues DDL finds none.
  let startedQueue = false;

  afterAll(async () => {
    if (startedQueue) await stopDDLQueue();
    if (!db) return;
    for (const name of names) {
      await dropTestCollection(db, name).catch(() => {});
      await sql`DELETE FROM zvd_permissions WHERE v2 = ${name}`.execute(db);
    }
    await reconcilePolicies();
  });

  it('DELETE /api/collections/:name', async () => {
    const name = `drop_route_${tag}`;
    await seed(name);
    const res = await app.request(`/api/collections/${name}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    await expectForgotten(name);
  });

  it('DDLManager.dropCollection on the pool (schema apply, extensions)', async () => {
    const name = `drop_pool_${tag}`;
    await seed(name);
    await DDLManager.dropCollection(db, name);
    await expectForgotten(name);
  });

  it('the rows go with the drop itself, so a lost after-commit step is only stale memory', async () => {
    const name = `drop_lost_${tag}`;
    await seed(name);
    const forget = spyOn(DDLManager, 'forgetDroppedCollection').mockResolvedValue(undefined);
    try {
      await DDLManager.dropCollection(db, name);
    } finally {
      forget.mockRestore();
    }
    // What a crash between the COMMIT and the follow-up leaves: the policy
    // reconcile brings the model to the table, which no longer holds the grant.
    await reconcilePolicies();
    await expectForgotten(name);
  });

  it('in every domain, and only for this collection', async () => {
    const name = `drop_doms_${tag}`;
    const other = `drop_doms_other_${tag}`;
    await seed(name);
    names.push(other);
    await DDLManager.createCollection(db, { name: other, fields });
    const e = await getEnforcer();
    const domains = [TENANT, OTHER_TENANT, '*'];
    for (const dom of domains) {
      await e.addPolicy(SUBJECT, dom, name, 'read');
      await e.addPolicy(SUBJECT, dom, other, 'read');
    }
    await e.addPolicy(SUBJECT, OTHER_TENANT, 'data', 'view_all');
    try {
      await DDLManager.dropCollection(db, name);
      for (const dom of domains) {
        expect(e.getModel().hasPolicy('p', 'p', [SUBJECT, dom, name, 'read'])).toBe(false);
        expect(e.getModel().hasPolicy('p', 'p', [SUBJECT, dom, other, 'read'])).toBe(true);
      }
      expect(e.getModel().hasPolicy('p', 'p', [SUBJECT, OTHER_TENANT, 'data', 'view_all'])).toBe(
        true,
      );
      expect(await subjectRows(name)).toBe(0);
      expect(await subjectRows(other)).toBe(3);
      await expectForgotten(name);
    } finally {
      await e.removePolicy(SUBJECT, OTHER_TENANT, 'data', 'view_all');
    }
  });

  // The after-commit step used to re-read the table for the name and skip the
  // removal when it found a row. A same-name create landing between the drop's
  // COMMIT and that read wrote its default grants, so the old collection's
  // tenant grant stayed in the live model and read the new collection until the
  // next reconcile — with no row left in the table to show for it.
  it('a same-name create between the COMMIT and the after-commit step', async () => {
    const name = `drop_race_${tag}`;
    await seed(name);
    const forget = spyOn(DDLManager, 'forgetDroppedCollection').mockResolvedValue(undefined);
    let deferred: Parameters<typeof DDLManager.forgetDroppedCollection>;
    try {
      await DDLManager.dropCollection(db, name);
      expect(forget).toHaveBeenCalledTimes(1);
      deferred = forget.mock.calls[0]!;
    } finally {
      forget.mockRestore();
    }
    await DDLManager.createCollection(db, { name, fields });
    await DDLManager.forgetDroppedCollection(...deferred);

    expect(await canRead(name)).toBe(false);
    const model = (await getEnforcer()).getModel();
    expect(model.hasPolicy('p', 'p', [SUBJECT, TENANT, name, 'read'])).toBe(false);
    // The new collection's own default grants, which the drop also deleted from
    // the old one, are held again and stay live.
    for (const action of ['read', 'create', 'update']) {
      expect(model.hasPolicy('p', 'p', ['tenant_member', '*', name, action])).toBe(true);
    }
    expect(await subjectRows(name)).toBe(0);
  });

  it('the drop_collection DDL queue job', async () => {
    const name = `drop_queue_${tag}`;
    await seed(name);
    if (!isDDLQueueStarted()) {
      await initDDLQueue(db);
      startedQueue = true;
    }
    await enqueueDDLJob(db, 'drop_collection', { name });
    await expectForgotten(name);
  }, 60_000);
});
