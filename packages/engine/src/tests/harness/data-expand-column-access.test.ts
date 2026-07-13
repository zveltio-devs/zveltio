/**
 * Phase C — `?expand=` must honour the RELATED collection's column permissions.
 * Regression: applyExpand fetched + serialized the related row without
 * applyColumnAccess, so a column hidden on the target collection leaked through
 * `{field}_expanded`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { invalidateColumnPermCache } from '../../lib/tenancy/column-permissions.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const PARENT = `hexpcol_p_${Date.now()}`;
const CHILD = `hexpcol_c_${Date.now()}`;

d('expand column access (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let parentId = '';
  let childId = '';
  let colPermId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    const textField = (name: string) =>
      ({ name, type: 'text', required: false, unique: false, indexed: false }) as never;

    // Parent has a column the role can't read.
    await DDLManager.createCollection(db, {
      name: PARENT,
      fields: [textField('title'), textField('secret')],
    } as never);
    await DDLManager.createCollection(db, {
      name: CHILD,
      fields: [
        textField('title'),
        {
          name: 'parent',
          type: 'm2o',
          required: false,
          unique: false,
          indexed: false,
          options: { related_collection: PARENT, on_delete: 'SET NULL' },
        },
      ],
    } as never);

    const perm = await db
      .insertInto('zvd_column_permissions')
      .values({
        collection_name: PARENT,
        column_name: 'secret',
        role: '*',
        can_read: false,
        can_write: true,
      })
      .returning('id')
      .executeTakeFirst();
    colPermId = perm?.id ?? '';
    await invalidateColumnPermCache(PARENT);

    parentId = (
      (await (
        await app.request(`/api/data/${PARENT}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', cookie },
          body: JSON.stringify({ title: 'p', secret: 'classified' }),
        })
      ).json()) as { id: string }
    ).id;

    const childRes = await app.request(`/api/data/${CHILD}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'c', parent: parentId }),
    });
    childId = ((await childRes.json()) as { id: string }).id;
  });

  afterAll(async () => {
    if (!db) return;
    if (colPermId) {
      await db
        .deleteFrom('zvd_column_permissions')
        .where('id', '=', colPermId)
        .execute()
        .catch(() => {});
    }
    for (const name of [CHILD, PARENT]) {
      await sql
        .raw(`DROP TABLE IF EXISTS "zvd_${name}" CASCADE`)
        .execute(db)
        .catch(() => {});
      await db
        .deleteFrom('zvd_collections')
        .where('name', '=', name)
        .execute()
        .catch(() => {});
    }
  });

  it('single expand hides an unreadable column on the related collection', async () => {
    const res = await app.request(`/api/data/${CHILD}/${childId}?expand=parent`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const expanded = body.parent_expanded as Record<string, unknown>;
    expect(expanded.id).toBe(parentId);
    expect(expanded.title).toBe('p');
    expect('secret' in expanded).toBe(false);
  });

  it('list expand hides an unreadable column on the related collection', async () => {
    const res = await app.request(`/api/data/${CHILD}?expand=parent`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: Record<string, unknown>[] };
    const row = body.records.find((r) => r.id === childId);
    const expanded = row?.parent_expanded as Record<string, unknown>;
    expect(expanded.id).toBe(parentId);
    expect('secret' in expanded).toBe(false);
  });
});
