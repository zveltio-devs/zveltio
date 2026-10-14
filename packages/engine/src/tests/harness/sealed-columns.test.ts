/**
 * L37 layer 2 — a column whose value is served to no one (a `password` field)
 * cannot be read by the request roles (migration 073, `zveltio_seal_columns`).
 *
 * The engine already strips it from every payload; this proves the net under
 * that: raw SQL on `zveltio_rls` reading the hash is refused, and every engine
 * read and write path over such a collection still answers. The seal follows
 * the fields — create, add, rename, retype, drop — and survives the boot grant
 * loops that re-grant whole tables.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager, reconcileSealedColumns } from '../../lib/data/index.js';
import { alterField } from '../../lib/data/field-changes.js';
import { DEFAULT_TENANT_ID } from '../../lib/route-db.js';
import {
  applyTenantRLS,
  initRlsEnforcementRole,
  withTenantIsolation,
} from '../../lib/tenancy/index.js';
import {
  asTenant,
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const COLLECTION = `hsealed_${STAMP}`;
const TABLE = `zvd_${COLLECTION}`;
const REFERRER = `hsealedref_${STAMP}`;
const LATER = `hsealedlater_${STAMP}`;
const PASSWORD = 'correct horse battery';

const text = (name: string) => ({
  name,
  type: 'text',
  required: false,
  unique: false,
  indexed: false,
});
const password = (name: string) => ({ ...text(name), type: 'password' });

d('sealed columns in the database (L37 layer 2, migration 073)', () => {
  let app: Hono;
  let db: Database;
  let member = '';
  let god = '';
  let memberId = '';
  let recordId = '';

  /** A statement as the member, on `zveltio_rls`, with the settings a request publishes. */
  const asMember = <T>(fn: (trx: Database) => Promise<T>) =>
    withTenantIsolation(DEFAULT_TENANT_ID, fn, {
      userId: memberId,
      identity: {
        userId: memberId,
        email: '',
        role: 'member',
        roles: ['member'],
        bypass: false,
        collectionAll: true,
        columnsAll: true,
      },
    });

  const rejection = async (p: Promise<unknown>) =>
    p.then(
      () => null,
      (err: unknown) => err as { errno?: string; message?: string },
    );

  const call = async (method: string, path: string, body?: unknown, cookie = member) => {
    const res = await app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text, json: () => JSON.parse(text) };
  };

  /** Which roles may read `column` of `table`. */
  const canRead = async (table: string, column: string) =>
    (
      await sql<{ role: string; ok: boolean }>`
        SELECT rolname AS role, has_column_privilege(oid, ${table}::regclass, ${column}, 'SELECT') AS ok
          FROM pg_roles
         WHERE rolname IN ('zveltio_rls', 'zveltio_worker', 'zveltio_flow_reader', 'zveltio_ext')
         ORDER BY rolname`.execute(db)
    ).rows;

  const storedHash = async (id: string) =>
    (
      await asTenant(db, DEFAULT_TENANT_ID, (trx) =>
        sql<{ pw: string | null }>`SELECT pw FROM ${sql.table(TABLE)} WHERE id = ${id}`.execute(
          trx,
        ),
      )
    ).rows[0]?.pw;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    ({ cookie: member, userId: memberId } = await createMemberSession(app, db, {
      grants: [COLLECTION, REFERRER, LATER].map((collection) => ({
        collection,
        actions: ['read', 'create', 'update', 'delete'],
      })),
    }));
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      adoptRules: true,
      fields: [{ ...text('title'), required: true }, password('pw')],
    } as never);
    await DDLManager.createCollection(db, {
      name: REFERRER,
      adoptRules: true,
      fields: [
        text('label'),
        {
          name: 'owner',
          type: 'm2o',
          required: false,
          unique: false,
          indexed: false,
          options: { related_collection: COLLECTION },
        },
      ],
    } as never);
    const res = await call('POST', `/api/data/${COLLECTION}`, { title: 'seed', pw: PASSWORD });
    expect(res.status).toBe(201);
    recordId = res.json().id;
  });

  afterAll(async () => {
    if (!db) return;
    for (const c of [REFERRER, LATER, COLLECTION]) await dropTestCollection(db, c).catch(() => {});
  });

  it('refuses the password column, and SELECT *, to zveltio_rls; serves the rest', async () => {
    const pw = await rejection(
      asMember(async (trx) => {
        const who = await sql<{ u: string }>`SELECT current_user AS u`.execute(trx);
        expect(who.rows[0]?.u).toBe('zveltio_rls');
        return sql`SELECT pw FROM ${sql.table(TABLE)} WHERE id = ${recordId}`.execute(trx);
      }),
    );
    expect(pw?.errno).toBe('42501');
    const star = await rejection(
      asMember((trx) => sql`SELECT * FROM ${sql.table(TABLE)}`.execute(trx)),
    );
    expect(star?.errno).toBe('42501');
    const copied = await rejection(
      asMember((trx) => sql`UPDATE ${sql.table(TABLE)} SET title = pw`.execute(trx)),
    );
    expect(copied?.errno).toBe('42501');
    const ok = await asMember((trx) =>
      sql<{ title: string }>`SELECT title FROM ${sql.table(TABLE)} WHERE id = ${recordId}`.execute(
        trx,
      ),
    );
    expect(ok.rows[0]?.title).toBe('seed');
  });

  it('columnNames leaves the sealed column out, so a select over its answer is readable', async () => {
    const cols = await DDLManager.columnNames(db, COLLECTION);
    expect(cols).toContain('title');
    expect(cols).not.toContain('pw');
    const rows = await asMember((trx) =>
      trx
        .selectFrom(TABLE as never)
        .select(cols as never)
        .execute(),
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('seals it from every narrower role too, and only it', async () => {
    for (const r of await canRead(TABLE, 'pw')) expect(r).toEqual({ role: r.role, ok: false });
    for (const r of await canRead(TABLE, 'title')) expect(r).toEqual({ role: r.role, ok: true });
    expect((await canRead(TABLE, 'pw')).map((r) => r.role)).toContain('zveltio_rls');
  });

  it('stores the hash, and no revision keeps a copy of it', async () => {
    expect(await storedHash(recordId)).toMatch(/^\$argon2id\$/);
    const leaked = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zv_revisions
       WHERE collection = ${COLLECTION} AND (data ? 'pw' OR coalesce(delta ? 'pw', false))`.execute(
      db,
    );
    expect(leaked.rows[0]?.n).toBe(0);
  });

  it('serves every REST path: list, get, patch, put, bulk, delete', async () => {
    const list = await call('GET', `/api/data/${COLLECTION}`);
    expect(list.status).toBe(200);
    expect(list.body).toContain('seed');
    expect(list.body).not.toContain('argon2');
    const one = await call('GET', `/api/data/${COLLECTION}/${recordId}`);
    expect(one.status).toBe(200);
    expect(one.json().title ?? one.json().data?.title).toBe('seed');
    expect(one.body).not.toContain('argon2');

    const patched = await call('PATCH', `/api/data/${COLLECTION}/${recordId}`, {
      title: 'patched',
      pw: 'another long password',
    });
    expect(patched.status).toBe(200);
    expect(patched.body).not.toContain('argon2');
    expect(await storedHash(recordId)).toMatch(/^\$argon2id\$/);
    const put = await call('PUT', `/api/data/${COLLECTION}/${recordId}`, { title: 'replaced' });
    expect(put.status).toBe(200);

    const bulk = await call('POST', `/api/data/${COLLECTION}/bulk`, {
      records: [
        { title: 'b1', pw: 'bulk password one' },
        { title: 'b2', pw: 'bulk password two' },
      ],
    });
    expect([200, 201]).toContain(bulk.status);
    expect(bulk.body).not.toContain('argon2');
    const ids = (await call('GET', `/api/data/${COLLECTION}?limit=50`))
      .json()
      .records.filter((r: { title: string }) => r.title.startsWith('b'))
      .map((r: { id: string }) => r.id);
    expect(ids.length).toBe(2);
    const bulkPatch = await call('PATCH', `/api/data/${COLLECTION}/bulk`, {
      records: ids.map((id: string) => ({ id, title: 'bulk-patched' })),
    });
    expect(bulkPatch.status).toBe(200);
    const bulkDelete = await call('DELETE', `/api/data/${COLLECTION}/bulk`, { ids });
    expect(bulkDelete.status).toBe(200);

    const scratch = await call('POST', `/api/data/${COLLECTION}`, { title: 'gone', pw: PASSWORD });
    expect(scratch.status).toBe(201);
    const del = await call('DELETE', `/api/data/${COLLECTION}/${scratch.json().id}`);
    expect([200, 204]).toContain(del.status);
  });

  it('expands a sealed target without its hash', async () => {
    const ref = await call('POST', `/api/data/${REFERRER}`, { label: 'r', owner: recordId });
    expect(ref.status).toBe(201);
    const res = await call('GET', `/api/data/${REFERRER}?expand=owner`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('owner_expanded');
    expect(res.body).toContain('replaced');
    expect(res.body).not.toContain('argon2');
  });

  it('reads and reverts revisions of a sealed collection (a tenant admin)', async () => {
    const list = await call(
      'GET',
      `/api/revisions?collection=${COLLECTION}&record_id=${recordId}`,
      undefined,
      god,
    );
    expect(list.status).toBe(200);
    expect(list.body).not.toContain('argon2');
    const revs = list.json().revisions;
    const first = (revs as Array<{ id: string; action: string }>).find(
      (r) => r.action === 'create',
    );
    expect(first).toBeDefined();
    const reverted = await call('POST', `/api/revisions/${first?.id}/revert`, undefined, god);
    expect(reverted.status).toBe(200);
  });

  it('pulls and pushes through sync', async () => {
    const pull = await call('POST', '/api/sync/pull', { collections: [TABLE] });
    expect(pull.status).toBe(200);
    expect(pull.body).toContain(recordId);
    expect(pull.body).not.toContain('argon2');
    const id = crypto.randomUUID();
    const push = await call('POST', '/api/sync/push', {
      operations: [
        { collection: TABLE, recordId: id, operation: 'create', payload: { title: 'synced' } },
        { collection: TABLE, recordId: id, operation: 'update', payload: { title: 'synced-2' } },
        { collection: TABLE, recordId: id, operation: 'delete', payload: {} },
      ],
    });
    expect(push.status).toBe(200);
    expect(push.json().results.map((r: { status: string }) => r.status)).toEqual([
      'ok',
      'ok',
      'ok',
    ]);
  });

  it('follows the fields: add, rename, retype, drop', async () => {
    // A regular field added to a sealed table is readable at once.
    await DDLManager.addField(db, COLLECTION, text('note') as never);
    expect((await canRead(TABLE, 'note')).every((r) => r.ok)).toBe(true);
    const withNote = await call('PATCH', `/api/data/${COLLECTION}/${recordId}`, { note: 'n' });
    expect(withNote.status).toBe(200);
    expect((await call('GET', `/api/data/${COLLECTION}/${recordId}`)).body).toContain('"note"');

    // Renamed, the column stays sealed under its new name.
    await alterField(db, COLLECTION, 'pw', { newName: 'secret_pw' });
    expect((await canRead(TABLE, 'secret_pw')).some((r) => r.ok)).toBe(false);
    expect((await call('GET', `/api/data/${COLLECTION}`)).status).toBe(200);

    // A text field retyped to password is sealed; dropped, the table is whole again.
    await alterField(db, COLLECTION, 'note', { newType: 'password' });
    expect((await canRead(TABLE, 'note')).some((r) => r.ok)).toBe(false);
    await DDLManager.removeField(db, COLLECTION, 'note');
    await DDLManager.removeField(db, COLLECTION, 'secret_pw');
    const whole = await sql<{ ok: boolean }>`
      SELECT has_table_privilege('zveltio_rls', ${TABLE}::regclass, 'SELECT') AS ok`.execute(db);
    expect(whole.rows[0]?.ok).toBe(true);
    expect((await call('GET', `/api/data/${COLLECTION}`)).status).toBe(200);
  });

  it('seals a password field added to a collection that had none, in the ADD', async () => {
    await DDLManager.createCollection(db, {
      name: LATER,
      adoptRules: true,
      fields: [text('title')],
    } as never);
    const LATER_TABLE = `zvd_${LATER}`;
    await DDLManager.addField(db, LATER, password('pin') as never);
    expect((await canRead(LATER_TABLE, 'pin')).some((r) => r.ok)).toBe(false);
    const res = await call('POST', `/api/data/${LATER}`, { title: 't', pin: 'a long enough pin' });
    expect(res.status).toBe(201);
    expect((await call('GET', `/api/data/${LATER}`)).status).toBe(200);
  });

  it('survives the boot grant loops, and the boot reconcile reseals a table', async () => {
    const LATER_TABLE = `zvd_${LATER}`;
    // The boot loop granting zveltio_rls, and the collection reconcile granting
    // the narrow roles, both re-run every start.
    await initRlsEnforcementRole(db);
    await applyTenantRLS(db, LATER_TABLE, { deferIndexes: true });
    expect((await canRead(LATER_TABLE, 'pin')).some((r) => r.ok)).toBe(false);
    expect((await canRead(LATER_TABLE, 'title')).every((r) => r.ok)).toBe(true);

    // An install upgrading into 073: whole-table grants, a password field.
    await sql.raw(`GRANT SELECT ON "${LATER_TABLE}" TO zveltio_rls, zveltio_worker`).execute(db);
    expect((await canRead(LATER_TABLE, 'pin')).some((r) => r.ok)).toBe(true);
    await reconcileSealedColumns(db);
    expect((await canRead(LATER_TABLE, 'pin')).some((r) => r.ok)).toBe(false);
  });
});
