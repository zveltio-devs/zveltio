/**
 * Phase C — list ?expand= applies column read mask on expanded relation rows.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { invalidateColumnPermCache } from '../../lib/tenancy/column-permissions.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const PARENT = `hexp_h_${Date.now()}`;
const CHILD = `hexp_c_${Date.now()}`;

d('data list expand column mask (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let parentId = '';
  let colPermId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    const textField = {
      name: 'title',
      type: 'text',
      required: true,
      unique: false,
      indexed: false,
    } as never;

    await DDLManager.createCollection(db, {
      name: PARENT,
      fields: [textField, { name: 'secret', type: 'text', required: false, unique: false, indexed: false }],
    });
    await DDLManager.createCollection(db, {
      name: CHILD,
      fields: [
        textField,
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

    const parentRes = await app.request(`/api/data/${PARENT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'parent-visible', secret: 'parent-secret' }),
    });
    expect(parentRes.status).toBe(201);
    parentId = ((await parentRes.json()) as { id: string }).id;

    const childRes = await app.request(`/api/data/${CHILD}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'child-row', parent: parentId }),
    });
    expect([200, 201]).toContain(childRes.status);

    const perm = await db
      .insertInto('zvd_column_permissions')
      .values({
        collection_name: PARENT,
        column_name: 'secret',
        role: '*',
        can_read: false,
        can_write: false,
      })
      .returning('id')
      .executeTakeFirst();
    colPermId = perm?.id ?? '';
    await invalidateColumnPermCache(PARENT);
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

  it('hides unreadable columns on expanded parent records in list GET', async () => {
    const res = await app.request(`/api/data/${CHILD}?expand=parent`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: Array<Record<string, unknown>> };
    const row = body.records.find((r) => r.title === 'child-row');
    expect(row).toBeDefined();
    const expanded = row?.parent_expanded as Record<string, unknown> | undefined;
    expect(expanded?.id).toBe(parentId);
    expect(expanded?.title).toBe('parent-visible');
    expect('secret' in (expanded ?? {})).toBe(false);
  });
});
