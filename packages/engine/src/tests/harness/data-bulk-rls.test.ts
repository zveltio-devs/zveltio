/**
 * RLS on the bulk write paths (handlers/bulk.ts).
 *
 * `PATCH /bulk` and `DELETE /bulk` load their rows through `applyRlsFilters`,
 * so a row the caller cannot see is reported as not found rather than
 * rewritten or deleted. `applyRlsFilters` itself is unit-tested
 * (rls-write-paths.test.ts), but nothing asserted that the bulk handlers call
 * it: dropping the filters from either handler left every bulk test green.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { invalidateRlsCache } from '../../lib/tenancy/rls.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hbulkrls_${Date.now()}`;

d('data bulk RLS (in-process)', () => {
  let app: Hono;
  let db: Database;
  let godCookie = '';
  let memberCookie = '';
  let policyId = '';

  const post = async (title: string, bucket: string): Promise<string> => {
    const res = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: godCookie },
      body: JSON.stringify({ title, bucket }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };

  const titleOf = async (id: string) =>
    (
      await sql<{ title: string }>`
        SELECT title FROM ${sql.id(`zvd_${COLLECTION}`)} WHERE id = ${id}
      `.execute(db)
    ).rows[0]?.title;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    godCookie = await createGodSession(app, db);
    ({ cookie: memberCookie } = await createMemberSession(app, db, {
      grants: [{ collection: COLLECTION, actions: ['read', 'update', 'delete'] }],
    }));

    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        { name: 'bucket', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);

    const policy = await app.request('/api/admin/rls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: godCookie },
      body: JSON.stringify({
        collection: COLLECTION,
        role: '*',
        filter_field: 'bucket',
        filter_op: 'eq',
        filter_value_source: 'static:open',
        description: 'only the open bucket on bulk writes',
      }),
    });
    expect(policy.status).toBe(201);
    policyId = ((await policy.json()) as { policy: { id: string } }).policy.id;
    await invalidateRlsCache(COLLECTION);
  });

  afterAll(async () => {
    if (!db) return;
    if (policyId) {
      await sql`DELETE FROM zvd_rls_policies WHERE id = ${policyId}::uuid`
        .execute(db)
        .catch(() => {});
    }
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

  it('bulk PATCH reports a row hidden by RLS as not found and leaves it unchanged', async () => {
    const openId = await post('open-u', 'open');
    const hiddenId = await post('hidden-u', 'restricted');

    const res = await app.request(`/api/data/${COLLECTION}/bulk`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: memberCookie },
      body: JSON.stringify({
        records: [
          { id: openId, title: 'open-updated' },
          { id: hiddenId, title: 'HACKED' },
        ],
      }),
    });
    expect(res.status).toBe(207);
    const body = (await res.json()) as {
      updated: number;
      errors: Array<{ id: string; errors: string[] }>;
    };
    expect(body.updated).toBe(1);
    expect(body.errors).toEqual([expect.objectContaining({ id: hiddenId })]);
    expect(body.errors[0]!.errors.join(' ')).toContain('not found');

    expect(await titleOf(openId)).toBe('open-updated');
    expect(await titleOf(hiddenId)).toBe('hidden-u');
  });

  it('bulk DELETE leaves a row hidden by RLS in place', async () => {
    const openId = await post('open-d', 'open');
    const hiddenId = await post('hidden-d', 'restricted');

    const res = await app.request(`/api/data/${COLLECTION}/bulk`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', cookie: memberCookie },
      body: JSON.stringify({ ids: [openId, hiddenId] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: number; ids: string[] };
    expect(body.ids).toEqual([openId]);

    expect(await titleOf(openId)).toBeUndefined();
    expect(await titleOf(hiddenId)).toBe('hidden-d');
  });
});
