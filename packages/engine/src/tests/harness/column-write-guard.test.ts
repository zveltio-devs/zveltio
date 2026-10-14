/**
 * L37 layer 1 — column write permissions enforced by the database
 * (migration 072, `lib/data/column-guard.ts`).
 *
 * The engine's filter (`filterWritableFields`) stays first; this proves the net
 * under it: a member's write to a forbidden column through raw SQL on the
 * request's own role is refused, a permitted one passes, and every write the
 * engine makes for itself — authorship, timestamps, a god's write, background
 * work, a foreign key's ON DELETE SET NULL — passes too.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { mapPgError } from '../../lib/data/write-pipeline.js';
import { DEFAULT_TENANT_ID } from '../../lib/route-db.js';
import { invalidateColumnPermCache, withTenantIsolation } from '../../lib/tenancy/index.js';
import {
  asTenant,
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hcolguard_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;
const PARENT = `zvd_${COLLECTION}_p`;

d('column write guard in the database (L37, migration 072)', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  let member = '';
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
        // Every collection grant: the subject here is columns, not R1.
        collectionAll: true,
      },
    });

  const rejection = async (p: Promise<unknown>) =>
    p.then(
      () => null,
      (err: unknown) => err as { errno?: string; message?: string },
    );

  const guardInstalled = async () =>
    (
      await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM pg_trigger
         WHERE tgrelid = to_regclass(${TABLE}) AND tgname = '_zv_column_guard'`.execute(db)
    ).rows[0]?.n === 1;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    ({ cookie: member, userId: memberId } = await createMemberSession(app, db, {
      grants: [{ collection: COLLECTION, actions: ['read', 'create', 'update', 'delete'] }],
    }));
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      adoptRules: true,
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        { name: 'secret', type: 'text', required: false, unique: false, indexed: false },
        { name: 'score', type: 'integer', required: false, unique: false, indexed: false },
      ],
    } as never);
    await sql.raw(`ALTER TABLE "${TABLE}" ALTER COLUMN score SET DEFAULT 7`).execute(db);
    await db
      .insertInto('zvd_column_permissions')
      .values([
        // Read-only for members: the engine's 403, and now the database's.
        {
          collection_name: COLLECTION,
          column_name: 'secret',
          role: 'member',
          can_read: true,
          can_write: false,
        },
        // Hidden from everyone: not writable either.
        {
          collection_name: COLLECTION,
          column_name: 'score',
          role: '*',
          can_read: false,
          can_write: false,
        },
      ])
      .execute();
    await invalidateColumnPermCache(COLLECTION);

    const res = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({ title: 'seed', secret: 'from-god', score: 1 }),
    });
    expect(res.status).toBe(201);
    recordId = ((await res.json()) as { id: string }).id;
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .deleteFrom('zvd_column_permissions')
      .where('collection_name', '=', COLLECTION)
      .execute()
      .catch(() => {});
    await sql
      .raw(`DROP TABLE IF EXISTS "${PARENT}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await dropTestCollection(db, COLLECTION).catch(() => {});
  });

  it('puts the guard on the table when a write restriction exists', async () => {
    expect(await guardInstalled()).toBe(true);
  });

  it('refuses a member UPDATE of a read-only column through raw SQL as zveltio_rls', async () => {
    const err = await rejection(
      asMember(async (trx) => {
        const who = await sql<{ u: string }>`SELECT current_user AS u`.execute(trx);
        expect(who.rows[0]?.u).toBe('zveltio_rls');
        await sql`UPDATE ${sql.table(TABLE)} SET secret = 'forged' WHERE id = ${recordId}`.execute(
          trx,
        );
      }),
    );
    expect(err).not.toBeNull();
    expect(err?.errno).toBe('42501');
    expect(err?.message).toContain('column-level permission denies writing secret');
    // The data API answers the database's refusal as a 403, not a 500.
    const mapped = mapPgError(err);
    expect(mapped?.status).toBe(403);
    expect(mapped?.body.error).toBe('column_write_denied');
    const row = await asTenant(db, DEFAULT_TENANT_ID, (trx) =>
      sql<{
        secret: string;
      }>`SELECT secret FROM ${sql.table(TABLE)} WHERE id = ${recordId}`.execute(trx),
    );
    expect(row.rows[0]?.secret).toBe('from-god');
  });

  it('refuses a member INSERT choosing a hidden column, and one choosing a read-only one', async () => {
    const hidden = await rejection(
      asMember((trx) =>
        sql`INSERT INTO ${sql.table(TABLE)} (title, score) VALUES ('x', 99)`.execute(trx),
      ),
    );
    expect(hidden?.message).toContain('denies writing score');
    const readOnly = await rejection(
      asMember((trx) =>
        sql`INSERT INTO ${sql.table(TABLE)} (title, secret) VALUES ('x', 'mine')`.execute(trx),
      ),
    );
    expect(readOnly?.message).toContain('denies writing secret');
  });

  it('lets a member write what they may: other columns, defaults left alone', async () => {
    await asMember(async (trx) => {
      await sql`UPDATE ${sql.table(TABLE)} SET title = 'renamed' WHERE id = ${recordId}`.execute(
        trx,
      );
      await sql`INSERT INTO ${sql.table(TABLE)} (title) VALUES ('member-raw')`.execute(trx);
    });
  });

  it('passes every engine write the member request makes through the data API', async () => {
    const created = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: member },
      body: JSON.stringify({ title: 'by-member' }),
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { id: string }).id;
    const patched = await app.request(`/api/data/${COLLECTION}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: member },
      body: JSON.stringify({ title: 'patched' }),
    });
    expect(patched.status).toBe(200);
    // The engine's filter still answers first, naming the field.
    const refused = await app.request(`/api/data/${COLLECTION}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: member },
      body: JSON.stringify({ secret: 'nope' }),
    });
    expect(refused.status).toBe(403);
    const row = await asTenant(db, DEFAULT_TENANT_ID, (trx) =>
      sql<{ created_by: string | null; updated_by: string | null; score: string }>`
        SELECT created_by, updated_by, score FROM ${sql.table(TABLE)} WHERE id = ${id}`.execute(
        trx,
      ),
    );
    expect(row.rows[0]?.created_by).toBe(memberId);
    expect(row.rows[0]?.updated_by).toBe(memberId);
    expect(Number(row.rows[0]?.score)).toBe(7);
  });

  it('exempts a god (data:view_all_columns) writing through the data API', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/${recordId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({ secret: 'god-again', score: 3 }),
    });
    expect(res.status).toBe(200);
  });

  it('stands down for the engine’s own work, which publishes no actor', async () => {
    await withTenantIsolation(DEFAULT_TENANT_ID, (trx) =>
      sql`UPDATE ${sql.table(TABLE)} SET secret = 'job', score = 5 WHERE id = ${recordId}`.execute(
        trx,
      ),
    );
  });

  it('stands down for a write the schema causes: ON DELETE SET NULL on a read-only column', async () => {
    await sql.raw(`CREATE TABLE "${PARENT}" (id uuid PRIMARY KEY)`).execute(db);
    await sql.raw(`GRANT SELECT, DELETE ON "${PARENT}" TO zveltio_rls`).execute(db);
    await sql
      .raw(
        `ALTER TABLE "${TABLE}" ADD COLUMN parent uuid REFERENCES "${PARENT}"(id) ON DELETE SET NULL`,
      )
      .execute(db);
    const pid = crypto.randomUUID();
    await sql`INSERT INTO ${sql.table(PARENT)} (id) VALUES (${pid})`.execute(db);
    await asTenant(db, DEFAULT_TENANT_ID, (trx) =>
      sql`UPDATE ${sql.table(TABLE)} SET parent = ${pid} WHERE id = ${recordId}`.execute(trx),
    );
    await db
      .insertInto('zvd_column_permissions')
      .values({
        collection_name: COLLECTION,
        column_name: 'parent',
        role: 'member',
        can_read: true,
        can_write: false,
      })
      .execute();
    await invalidateColumnPermCache(COLLECTION);
    await asMember((trx) => sql`DELETE FROM ${sql.table(PARENT)} WHERE id = ${pid}`.execute(trx));
    const row = await asTenant(db, DEFAULT_TENANT_ID, (trx) =>
      sql<{
        parent: string | null;
      }>`SELECT parent FROM ${sql.table(TABLE)} WHERE id = ${recordId}`.execute(trx),
    );
    expect(row.rows[0]?.parent).toBeNull();
  });

  it('takes the guard off when the last restriction goes, and the write passes', async () => {
    await db
      .deleteFrom('zvd_column_permissions')
      .where('collection_name', '=', COLLECTION)
      .execute();
    await invalidateColumnPermCache(COLLECTION);
    expect(await guardInstalled()).toBe(false);
    await asMember((trx) =>
      sql`UPDATE ${sql.table(TABLE)} SET secret = 'now-allowed' WHERE id = ${recordId}`.execute(
        trx,
      ),
    );
  });
});
