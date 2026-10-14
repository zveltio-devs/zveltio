/**
 * L37 layer 3 — a column a rule hides from a role is hidden by the database
 * too (migration 075, `zveltio_mask_columns`).
 *
 * The request role loses SELECT on a ruled column of the table; the engine
 * reads through `zvv_<collection>`, a definer view that serves the column as
 * NULL to the actor the rule names and whole to `columns_all`, to no actor and
 * to the engine's own reads of a written row. Tenant isolation still binds the
 * view, and it follows every rule and field change.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { parseMigrationFile } from '../../db/migrations/index.js';
import { DDLManager, reconcileSealedColumns } from '../../lib/data/index.js';
import { alterField } from '../../lib/data/field-changes.js';
import { DEFAULT_TENANT_ID } from '../../lib/route-db.js';
import {
  deleteColumnPermission,
  putColumnPermission,
  withTenantIsolation,
} from '../../lib/tenancy/index.js';
import {
  asEveryTenant,
  asTenant,
  connectedAsSuperuser,
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const COLLECTION = `hmask_${STAMP}`;
const TABLE = `zvd_${COLLECTION}`;
const VIEW = `zvv_${COLLECTION}`;
const OTHER_TENANT = crypto.randomUUID();

const field = (name: string, type = 'text') => ({
  name,
  type,
  required: false,
  unique: false,
  indexed: false,
});

d('masking views (L37 layer 3, migration 075)', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  let member = '';
  let memberId = '';
  let recordId = '';
  let otherId = '';
  /** False on a superuser lane: a definer view owned by a superuser would read every tenant. */
  let definer = true;
  const ruleIds: string[] = [];

  /** A statement on `zveltio_rls`, as a request by the member publishes it. */
  const asMember = <T>(fn: (trx: Database) => Promise<T>, columnsAll = false) =>
    withTenantIsolation(DEFAULT_TENANT_ID, fn, {
      userId: memberId,
      identity: {
        userId: memberId,
        email: '',
        role: 'member',
        roles: ['member'],
        bypass: false,
        collectionAll: true,
        columnsAll,
      },
    });

  const rejection = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (err: unknown) => err as { errno?: string },
    );

  // As jsonb: a prepared `SELECT *` whose columns a field change altered fails
  // once per pooled connection (0A000), the view's as a table's.
  const viewRow = (trx: Database, id = recordId) =>
    sql<{
      r: Record<string, unknown>;
    }>`SELECT to_jsonb(v) AS r FROM ${sql.table(VIEW)} v WHERE id = ${id}`
      .execute(trx)
      .then((r) => r.rows[0]?.r);

  const call = async (method: string, path: string, cookie: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text, json: () => JSON.parse(text) };
  };

  const hide = async (column: string) => {
    const row = await putColumnPermission(db, {
      collection_name: COLLECTION,
      column_name: column,
      role: 'member',
      can_read: false,
      can_write: false,
    });
    ruleIds.push(String(row?.id));
    return String(row?.id);
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    definer = !(await connectedAsSuperuser(db));
    god = await createGodSession(app, db);
    ({ cookie: member, userId: memberId } = await createMemberSession(app, db, {
      grants: [{ collection: COLLECTION, actions: ['read', 'create', 'update', 'delete'] }],
    }));
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      adoptRules: true,
      fields: [field('title'), field('salary', 'number'), field('notes')],
    } as never);
    await hide('salary');
    const res = await call('POST', `/api/data/${COLLECTION}`, god, {
      title: 'seed',
      salary: 5000,
      notes: 'quarterly bonus',
    });
    expect(res.status).toBe(201);
    recordId = res.json().id;

    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${OTHER_TENANT}::uuid, ${`hmask-${STAMP}`}, 'hmask', 'active')
              ON CONFLICT (id) DO NOTHING`.execute(db);
    otherId = (
      await asTenant(db, OTHER_TENANT, (trx) =>
        sql<{ id: string }>`INSERT INTO ${sql.table(TABLE)} (title, salary)
                            VALUES ('other firm', 1) RETURNING id`.execute(trx),
      )
    ).rows[0]!.id;
  });

  afterAll(async () => {
    if (!db) return;
    for (const id of ruleIds) await deleteColumnPermission(db, id).catch(() => {});
    await dropTestCollection(db, COLLECTION).catch(() => {});
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER_TENANT}::uuid`.execute(db).catch(() => {});
  });

  it('takes a ruled column from the request role on the table, and only it', async () => {
    const salary = await rejection(
      asMember((trx) =>
        sql`SELECT salary FROM ${sql.table(TABLE)} WHERE id = ${recordId}`.execute(trx),
      ),
    );
    // An invoker view reads the table as the caller, who keeps the column.
    if (!definer) return expect(salary).toBeNull();
    expect(salary?.errno).toBe('42501');
    // A god's request role is the same role: the table refuses it too.
    const asGod = await rejection(
      asMember((trx) => sql`SELECT salary FROM ${sql.table(TABLE)}`.execute(trx), true),
    );
    expect(asGod?.errno).toBe('42501');
    const title = await asMember((trx) =>
      sql<{ title: string }>`SELECT title FROM ${sql.table(TABLE)} WHERE id = ${recordId}`.execute(
        trx,
      ),
    );
    expect(title.rows[0]?.title).toBe('seed');
  });

  it('serves the column as NULL to the member, whole to columns_all and to no actor', async () => {
    const masked = await asMember((trx) => viewRow(trx));
    expect(masked?.title).toBe('seed');
    expect(masked?.salary).toBeNull();
    expect(Number((await asMember((trx) => viewRow(trx), true))?.salary)).toBe(5000);
    const noActor = await withTenantIsolation(DEFAULT_TENANT_ID, (trx) => viewRow(trx));
    expect(Number(noActor?.salary)).toBe(5000);
  });

  it('is a definer view (invoker under a superuser owner) that tenant isolation binds, never a barrier', async () => {
    const opts = await sql<{ o: string[] | null }>`
      SELECT reloptions AS o FROM pg_class WHERE oid = ${`public.${VIEW}`}::regclass`.execute(db);
    expect(opts.rows[0]?.o ?? []).toEqual(definer ? [] : ['security_invoker=true']);
    const ids = await asMember((trx) =>
      sql<{ id: string }>`SELECT id FROM ${sql.table(VIEW)}`.execute(trx),
    );
    expect(ids.rows.map((r) => r.id)).toContain(recordId);
    expect(ids.rows.map((r) => r.id)).not.toContain(otherId);
    const there = await withTenantIsolation(OTHER_TENANT, (trx) =>
      sql<{ id: string }>`SELECT id FROM ${sql.table(VIEW)}`.execute(trx),
    );
    expect(there.rows.map((r) => r.id)).toEqual([otherId]);
    // Flattened: the page every list asks for still walks the index.
    const plan = await asEveryTenant(db, (trx) =>
      sql<{ 'QUERY PLAN': string }>`EXPLAIN SELECT * FROM ${sql.table(VIEW)}
                                     ORDER BY created_at DESC LIMIT 5`.execute(trx),
    );
    expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).not.toContain('Subquery Scan');
  });

  it('serves the data API as before, and a write by the member keeps the hidden value', async () => {
    const seen = await call('GET', `/api/data/${COLLECTION}/${recordId}`, member);
    expect(seen.status).toBe(200);
    expect(seen.json()).not.toHaveProperty('salary');
    const list = await call('GET', `/api/data/${COLLECTION}`, member);
    expect(list.status).toBe(200);
    const patched = await call('PATCH', `/api/data/${COLLECTION}/${recordId}`, member, {
      title: 'renamed by member',
    });
    expect(patched.status).toBe(200);
    expect(patched.json()).not.toHaveProperty('salary');
    const full = await call('GET', `/api/data/${COLLECTION}/${recordId}`, god);
    expect(full.json()).toMatchObject({ title: 'renamed by member', salary: 5000 });
    // The revision is the engine's read of the written row: whole.
    const rev = await asEveryTenant(db, (trx) =>
      sql<{ data: Record<string, unknown> }>`
        SELECT data FROM zv_revisions
         WHERE collection = ${COLLECTION} AND record_id = ${recordId} AND action = 'update'
         ORDER BY created_at DESC LIMIT 1`.execute(trx),
    );
    expect(Number(rev.rows[0]?.data.salary)).toBe(5000);
  });

  it('follows a rule change: a new rule masks and seals, its removal gives both back', async () => {
    const id = await hide('notes');
    const masked = await asMember((trx) => viewRow(trx));
    expect(masked?.notes).toBeNull();
    // `search_text` is built from every text field, notes included.
    expect(masked?.search_text ?? null).toBeNull();
    const sealed = await rejection(
      asMember((trx) => sql`SELECT notes FROM ${sql.table(TABLE)}`.execute(trx)),
    );
    expect(sealed?.errno ?? null).toBe(definer ? '42501' : null);

    await deleteColumnPermission(db, id);
    expect((await asMember((trx) => viewRow(trx)))?.notes).toBe('quarterly bonus');
    const back = await asMember((trx) =>
      sql<{ notes: string }>`SELECT notes FROM ${sql.table(TABLE)} WHERE id = ${recordId}`.execute(
        trx,
      ),
    );
    expect(back.rows[0]?.notes).toBe('quarterly bonus');
  });

  it('follows the fields: add, rename (the rule with it), retype and drop', async () => {
    await DDLManager.addField(db, COLLECTION, field('extra') as never);
    expect(await asMember((trx) => viewRow(trx))).toHaveProperty('extra');

    await alterField(db, COLLECTION, 'salary', { newName: 'pay' });
    const renamed = await asMember((trx) => viewRow(trx));
    expect(renamed).toHaveProperty('pay', null);
    expect(renamed).not.toHaveProperty('salary');
    expect(Number((await asMember((trx) => viewRow(trx), true))?.pay)).toBe(5000);

    await alterField(db, COLLECTION, 'extra', { newType: 'number' });
    await DDLManager.removeField(db, COLLECTION, 'extra');
    const dropped = await asMember((trx) => viewRow(trx));
    expect(dropped).not.toHaveProperty('extra');
    expect(dropped).toHaveProperty('pay', null);
  });

  it('is put back by the boot reconcile, as an upgrade into 075 needs', async () => {
    await sql`DROP VIEW ${sql.table(VIEW)}`.execute(db);
    expect(await reconcileSealedColumns(db)).toBeGreaterThan(0);
    expect((await asMember((trx) => viewRow(trx)))?.pay).toBeNull();
  });

  it("075's DOWN takes the views away and gives the ruled columns back", async () => {
    const file = Bun.file(
      new URL('../../db/migrations/sql/075_masking_views.sql', import.meta.url),
    );
    const { down } = parseMigrationFile(await file.text()) as { down: string };
    const undone = new Error('rolled back');
    const seen = await db
      .transaction()
      .execute(async (trx) => {
        await sql.raw(down).execute(trx);
        const r = await sql<{ view: string | null; pay: boolean; fn: string | null }>`
          SELECT to_regclass(${`public.${VIEW}`})::text AS view,
                 has_column_privilege('zveltio_rls', ${TABLE}::regclass, 'pay', 'SELECT') AS pay,
                 to_regprocedure('zveltio_mask_columns(regclass,text[],text[],text[])')::text AS fn
        `.execute(trx);
        throw Object.assign(undone, { seen: r.rows[0] });
      })
      .catch((err: Error & { seen?: unknown }) =>
        err === undone ? err.seen : Promise.reject(err),
      );
    expect(seen).toEqual({ view: null, pay: true, fn: null });
    expect((await asMember((trx) => viewRow(trx)))?.pay).toBeNull();
  });
});
