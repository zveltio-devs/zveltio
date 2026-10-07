/**
 * A write answers with the written row — and that row is a READ.
 *
 * `GET` stripped columns the caller may not read; `POST`, `PUT`, `PATCH` and
 * the bulk create/update answered with the whole row instead. A member with
 * read + update on a collection, and no read on `secret`, changed `title` by
 * `PATCH` and got `secret` back in the response. The virtual-collection branch
 * masked its echo; the table branch did not.
 *
 * Driven by a real member. God sets the data up and must still see the column.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { invalidateColumnPermCache } from '../../lib/tenancy/column-permissions.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hwrm_${Date.now()}`;
const SECRET = 'SECRET99';

type Row = Record<string, unknown>;

d('write responses omit columns the caller may not read', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  let member = '';
  let recordId = '';

  const send = async (cookie: string, method: string, path: string, body: unknown) => {
    const res = await app.request(`/api/data/${COLLECTION}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Row };
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    ({ cookie: member } = await createMemberSession(app, db, {
      grants: [{ collection: COLLECTION, actions: ['read', 'create', 'update'] }],
    }));
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        { name: 'secret', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);
    await db
      .insertInto('zvd_column_permissions')
      .values({
        collection_name: COLLECTION,
        column_name: 'secret',
        role: '*',
        can_read: false,
        can_write: false,
      })
      .execute();
    await invalidateColumnPermCache(COLLECTION);

    const created = await send(god, 'POST', '', { title: 'seed', secret: SECRET });
    expect(created.status).toBe(201);
    expect(created.body.secret).toBe(SECRET);
    recordId = created.body.id as string;
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .deleteFrom('zvd_column_permissions')
      .where('collection_name', '=', COLLECTION)
      .execute()
      .catch(() => {});
    await invalidateColumnPermCache(COLLECTION).catch(() => {});
    await sql
      .raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  it('PATCH', async () => {
    const r = await send(member, 'PATCH', `/${recordId}`, { title: 'patched' });
    expect(r.status).toBe(200);
    expect(r.body.title).toBe('patched');
    expect('secret' in r.body).toBe(false);
  });

  it('PUT', async () => {
    const r = await send(member, 'PUT', `/${recordId}`, { title: 'replaced' });
    expect(r.status).toBe(200);
    expect(r.body.title).toBe('replaced');
    expect('secret' in r.body).toBe(false);
  });

  it('POST', async () => {
    const r = await send(member, 'POST', '', { title: 'by member' });
    expect(r.status).toBe(201);
    expect(r.body.title).toBe('by member');
    expect('secret' in r.body).toBe(false);
  });

  it('POST /bulk and PATCH /bulk', async () => {
    const c = await send(member, 'POST', '/bulk', { records: [{ title: 'b1' }] });
    expect(c.status).toBe(201);
    const created = (c.body.records as Row[])[0]!;
    expect(created.title).toBe('b1');
    expect('secret' in created).toBe(false);

    const u = await send(member, 'PATCH', '/bulk', { records: [{ id: recordId, title: 'bulk' }] });
    expect(u.status).toBe(200);
    const updated = (u.body.records as Row[])[0]!;
    expect(updated.title).toBe('bulk');
    expect('secret' in updated).toBe(false);
  });

  it('the stored value is untouched, and god still sees it in a write response', async () => {
    const r = await send(god, 'PATCH', `/${recordId}`, { title: 'by god' });
    expect(r.status).toBe(200);
    expect(r.body.secret).toBe(SECRET);
  });
});
