/**
 * Phase C — single-record m2o expand (handlers/single.ts GET ?expand=).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const PARENT = `hsexp_p_${Date.now()}`;
const CHILD = `hsexp_c_${Date.now()}`;

d('data single expand (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let parentId = '';
  let childId = '';

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

    await DDLManager.createCollection(db, { name: PARENT, fields: [textField] });
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

    parentId = (
      (await (
        await app.request(`/api/data/${PARENT}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', cookie },
          body: JSON.stringify({ title: 'parent-one' }),
        })
      ).json()) as { id: string }
    ).id;

    const childRes = await app.request(`/api/data/${CHILD}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'child-one', parent: parentId }),
    });
    expect(childRes.status).toBe(201);
    childId = ((await childRes.json()) as { id: string }).id;
  });

  afterAll(async () => {
    if (!db) return;
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

  it('expands m2o on GET /:id?expand=', async () => {
    const res = await app.request(`/api/data/${CHILD}/${childId}?expand=parent`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const expanded = body.parent_expanded as { id?: string; title?: string } | undefined;
    expect(expanded?.id).toBe(parentId);
    expect(expanded?.title).toBe('parent-one');
  });
});
