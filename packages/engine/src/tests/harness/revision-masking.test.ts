/**
 * L37 — a revision does not give back a column a rule hides (migration 077).
 *
 * `zv_revisions` keeps the whole row, hidden columns included, and the request
 * role read it directly: raw SQL on `zveltio_rls` took back from history what
 * the masking view (075) withholds from the live row. The request role now
 * holds no SELECT on `data`/`delta`; it reads them through `zvv__revisions`,
 * which strips the actor's hidden keys and the search columns and stands down
 * as `zvv_<collection>` does. The admin's history keeps every value.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { parseMigrationFile } from '../../db/migrations/index.js';
import { DDLManager, reconcileSealedColumns } from '../../lib/data/index.js';
import { DEFAULT_TENANT_ID } from '../../lib/route-db.js';
import {
  deleteColumnPermission,
  putColumnPermission,
  withTenantIsolation,
} from '../../lib/tenancy/index.js';
import {
  connectedAsSuperuser,
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const COLLECTION = `hrevmask_${STAMP}`;
const VIEW = 'zvv__revisions';

const field = (name: string, type = 'text') => ({
  name,
  type,
  required: false,
  unique: false,
  indexed: false,
});

d('revision masking (L37, migration 077)', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  let member = '';
  let memberId = '';
  let recordId = '';
  let definer = true;
  let ruleId = '';
  let before = '';

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

  const call = async (method: string, path: string, cookie: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text, json: () => JSON.parse(text) };
  };

  /** Every salary a statement can find in this record's history, or the refusal. */
  const salaries = (trx: Database, from: string) =>
    sql<{ s: string | null }>`
      SELECT coalesce(data->>'salary', delta->>'salary') AS s FROM ${sql.table(from)}
       WHERE collection = ${COLLECTION} AND record_id = ${recordId}`
      .execute(trx)
      .then(
        (r) => r.rows.map((x) => x.s),
        (err: { errno?: string }) => err.errno ?? String(err),
      );

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
    const rule = await putColumnPermission(db, {
      collection_name: COLLECTION,
      column_name: 'salary',
      role: 'member',
      can_read: false,
      can_write: false,
    });
    ruleId = String(rule?.id);
    const created = await call('POST', `/api/data/${COLLECTION}`, god, {
      title: 'seed',
      salary: 5000,
      notes: 'quarterly bonus',
    });
    expect(created.status).toBe(201);
    recordId = created.json().id;
    before = new Date().toISOString();
    await Bun.sleep(5);
    const patched = await call('PATCH', `/api/data/${COLLECTION}/${recordId}`, god, {
      salary: 7000,
    });
    expect(patched.status).toBe(200);
  });

  afterAll(async () => {
    if (!db) return;
    if (ruleId) await deleteColumnPermission(db, ruleId).catch(() => {});
    await dropTestCollection(db, COLLECTION).catch(() => {});
  });

  it('gives the request role no hidden value from zv_revisions, raw or through the view', async () => {
    const raw = await asMember((trx) => salaries(trx, 'zv_revisions'));
    // An invoker view reads the table as the caller, who keeps the columns:
    // the shape the engine warns about at boot, as for 075.
    if (definer) expect(raw).toBe('42501');
    const viewed = await asMember((trx) => salaries(trx, VIEW));
    expect(viewed).toEqual([null, null]);
    // `search_text` carries every text field, a hidden one's too.
    const keys = await asMember((trx) =>
      sql<{ k: string[] }>`
        SELECT ARRAY(SELECT jsonb_object_keys(data)) AS k FROM ${sql.table(VIEW)}
         WHERE collection = ${COLLECTION} AND record_id = ${recordId} AND action = 'create'`.execute(
        trx,
      ),
    );
    expect(keys.rows[0]?.k).toContain('title');
    expect(keys.rows[0]?.k).not.toContain('search_text');
    expect(keys.rows[0]?.k).not.toContain('search_vector');
  });

  it('keeps every value for columns_all and for no actor, and the table keeps it stored', async () => {
    const all = await asMember((trx) => salaries(trx, VIEW), true);
    expect([...(all as string[])].sort()).toEqual(['5000', '7000']);
    const engine = await withTenantIsolation(DEFAULT_TENANT_ID, (trx) => salaries(trx, VIEW));
    expect([...(engine as string[])].sort()).toEqual(['5000', '7000']);
  });

  it('serves time travel to the member without the column, and to the god with it', async () => {
    const one = await call('GET', `/api/data/${COLLECTION}/${recordId}?as_of=${before}`, member);
    expect(one.status).toBe(200);
    expect(one.json().record).toMatchObject({ title: 'seed' });
    expect(one.json().record).not.toHaveProperty('salary');
    const list = await call('GET', `/api/data/${COLLECTION}?as_of=${before}`, member);
    expect(list.status).toBe(200);
    expect(list.body).not.toContain('5000');
    const godOne = await call('GET', `/api/data/${COLLECTION}/${recordId}?as_of=${before}`, god);
    expect(Number(godOne.json().record.salary)).toBe(5000);
  });

  it("keeps the admin's audit trail whole, and a revert restores the hidden value", async () => {
    const res = await call('GET', `/api/revisions?collection=${COLLECTION}`, god);
    expect(res.status).toBe(200);
    const revs = res.json().revisions as {
      id: string;
      action: string;
      data: { salary: unknown };
    }[];
    const first = revs.find((r) => r.action === 'create')!;
    expect(Number(first.data.salary)).toBe(5000);
    const reverted = await call('POST', `/api/revisions/${first.id}/revert`, god);
    expect(reverted.status).toBe(200);
    const now = await call('GET', `/api/data/${COLLECTION}/${recordId}`, god);
    expect(Number(now.json().salary)).toBe(5000);
  });

  it('is put back by the boot reconcile', async () => {
    await sql`DROP VIEW ${sql.table(VIEW)}`.execute(db);
    expect(await reconcileSealedColumns(db)).toBeGreaterThan(0);
    expect(await asMember((trx) => salaries(trx, VIEW))).not.toContain('5000');
  });

  it("077's DOWN takes the view away and gives the request role the columns back", async () => {
    const file = Bun.file(
      new URL('../../db/migrations/sql/077_revision_masking.sql', import.meta.url),
    );
    const { down } = parseMigrationFile(await file.text()) as { down: string };
    const undone = new Error('rolled back');
    const seen = await db
      .transaction()
      .execute(async (trx) => {
        await sql.raw(down).execute(trx);
        const r = await sql<{ view: string | null; data: boolean; whole: boolean }>`
          SELECT to_regclass(${`public.${VIEW}`})::text AS view,
                 has_column_privilege('zveltio_rls', 'zv_revisions', 'data', 'SELECT') AS data,
                 has_table_privilege('zveltio_rls', 'zv_revisions', 'SELECT') AS whole`.execute(
          trx,
        );
        throw Object.assign(undone, { seen: r.rows[0] });
      })
      .catch((err: Error & { seen?: unknown }) =>
        err === undone ? err.seen : Promise.reject(err),
      );
    expect(seen).toEqual({ view: null, data: true, whole: true });
  });
});
