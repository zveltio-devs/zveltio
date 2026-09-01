/**
 * C-1 / M-4 — what actually lands in the row on a dynamic write.
 *
 * `dynamicInsert` filtered a RESERVED set out of the payload, and that set
 * included `created_by` and `updated_by` — the two columns the engine had just
 * filled in from the session one function earlier. The filter did what it said;
 * the two rules were simply never read together. Every row written through the
 * data API landed with NULL authorship, and every RLS policy scoping "own
 * records" by `created_by` therefore matched nothing.
 *
 * The reason it survived is worth naming: a test that asserts the API's
 * RESPONSE passes either way, because `RETURNING *` returns the row it just
 * wrote and NULL is a perfectly good value to return. So these assertions read
 * the column back out of the database, and the audit that found this said so in
 * as many words: assert the persisted value.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hauth_${Date.now()}`;

d('dynamic write authorship (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  const tableName = `zvd_${COLLECTION}`;

  /** The row as the DATABASE holds it — not as the API reported it. */
  async function persisted(id: string) {
    const { rows } = await sql<{
      created_by: string | null;
      updated_by: string | null;
      tenant_id: string | null;
    }>`SELECT created_by, updated_by, tenant_id FROM ${sql.id(tableName)} WHERE id = ${id}`.execute(
      db,
    );
    return rows[0];
  }

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
  });

  afterAll(async () => {
    if (!db) return;
    await sql
      .raw(`DROP TABLE IF EXISTS "${tableName}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  it('stamps created_by and updated_by on a single create', async () => {
    const res = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'one' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { record?: { id: string }; id?: string };
    const id = body.record?.id ?? body.id!;

    const row = await persisted(id);
    expect(row?.created_by).not.toBeNull();
    expect(row?.updated_by).not.toBeNull();
  });

  it('stamps them on a bulk create too', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/bulk`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: [{ title: 'bulk-a' }, { title: 'bulk-b' }] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { records: Array<{ id: string }> };
    expect(body.records).toHaveLength(2);

    for (const r of body.records) {
      const row = await persisted(r.id);
      expect(row?.created_by).not.toBeNull();
    }
  });

  // M-4. The payload does not choose the tenant. RLS refuses a forged value on
  // the enforcing role, but only there — a superuser connection writes it
  // happily — so the filter is what makes this hold regardless of how the
  // database is configured.
  it('ignores a tenant_id supplied in the payload', async () => {
    const forged = '00000000-0000-4000-8000-0000000000ff';
    const res = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'forged-tenant', tenant_id: forged }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { record?: { id: string }; id?: string };

    const row = await persisted(body.record?.id ?? body.id!);
    expect(row?.tenant_id).not.toBe(forged);
  });

  // H-5. `dynamicInsert` got the `system` channel and `dynamicUpdate` did not,
  // which left `updated_by` frozen at whatever the INSERT wrote. That is worse
  // than the NULL it replaced: a NULL is visibly unpopulated, while a stale
  // author asserts that the creator last modified a record they may not have
  // touched since. The value has to MOVE, so the test changes it and looks.
  it('moves updated_by when someone else edits the record', async () => {
    const create = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'before' }),
    });
    const created = (await create.json()) as { record?: { id: string }; id?: string };
    const id = created.record?.id ?? created.id!;
    const atInsert = await persisted(id);

    // A second author — `createGodSession` mints a fresh user each call. Editing
    // as the same user would pass whether or not the column ever moves.
    const otherCookie = await createGodSession(app, db);

    const patch = await app.request(`/api/data/${COLLECTION}/${id}`, {
      method: 'PATCH',
      headers: { cookie: otherCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'after' }),
    });
    expect(patch.status).toBe(200);

    const afterEdit = await persisted(id);
    expect(afterEdit?.updated_by).not.toBeNull();
    // created_by must NOT move: it records who made the row, not who touched it.
    expect(afterEdit?.created_by).toBe(atInsert!.created_by);
    // And the point of the finding: it is no longer the value from the INSERT.
    expect(afterEdit?.updated_by).not.toBe(atInsert!.updated_by);
  });

  // Authorship is engine-supplied, so a caller claiming to be someone else must
  // not win. This is the half the RESERVED filter was always right about, and
  // it has to keep holding now that the trusted values arrive by another route.
  it('ignores a created_by supplied in the payload', async () => {
    // A session of its own, because the test above minted a second god.
    //
    // `createGodSession` stands the previous god down — one god per instance is
    // the product's rule and the database enforces it — so the `cookie` from
    // `beforeAll` belongs to a demoted member by the time this runs. This used
    // to pass anyway: the helper changed the role behind `isGodUser`'s cache,
    // which kept answering "god" for five seconds, so the stale cache was doing
    // the work the session should have. With the cache invalidated properly the
    // demotion is immediate and this test failed — correctly, and for the first
    // time honestly.
    const freshCookie = await createGodSession(app, db);
    const res = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { cookie: freshCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'forged-author', created_by: 'someone-else' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { record?: { id: string }; id?: string };

    const row = await persisted(body.record?.id ?? body.id!);
    expect(row?.created_by).not.toBe('someone-else');
    expect(row?.created_by).not.toBeNull();
  });
});
