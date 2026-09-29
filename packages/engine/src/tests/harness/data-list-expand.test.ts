/**
 * Phase C — data LIST with ?expand= (handlers/list.ts + shape.applyExpand).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager, queryAlterRegistry } from '../../lib/data/index.js';
import { entityAccessRegistry } from '../../lib/tenancy/entity-access.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const PARENT = `hexp_p_${Date.now()}`;
const CHILD = `hexp_c_${Date.now()}`;
const OWNER = 'harness-expand-gate';

d('data list expand (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let parentId: string;

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

    const parentRes = await app.request(`/api/data/${PARENT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'parent-row' }),
    });
    expect(parentRes.status).toBe(201);
    const parentBody = (await parentRes.json()) as { id?: string };
    parentId = parentBody.id ?? '';
    expect(parentId).toBeTruthy();

    const childRes = await app.request(`/api/data/${CHILD}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'child-row', parent: parentId }),
    });
    expect([200, 201]).toContain(childRes.status);
  });

  afterEach(() => {
    queryAlterRegistry.unregisterAll(OWNER);
    entityAccessRegistry.unregisterAll(OWNER);
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

  it('expands an m2o relation on GET /api/data/:collection?expand=', async () => {
    const res = await app.request(`/api/data/${CHILD}?expand=parent`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      records: Array<Record<string, unknown>>;
    };
    expect(body.records.length).toBeGreaterThanOrEqual(1);
    const row = body.records.find((r) => r.title === 'child-row');
    expect(row).toBeDefined();
    const expanded = row?.parent_expanded as { id?: string; title?: string } | undefined;
    expect(expanded?.id).toBe(parentId);
    expect(expanded?.title).toBe('parent-row');
  });

  // Expand once applied the target's row policies and columns only: a parent an
  // extension's alter or ownership rule hides came back nested in its child.
  const expandedParent = async (path: string) => {
    const res = await app.request(`/api/data/${CHILD}${path}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    // The list answers `{ records }`; `GET /:id` answers the record itself.
    const body = (await res.json()) as Record<string, unknown> & {
      records?: Array<Record<string, unknown>>;
    };
    const row = body.records ? body.records.find((r) => r.title === 'child-row') : body;
    expect(row?.title).toBe('child-row');
    return row?.parent_expanded;
  };

  it('does not expand a target row an extension query alter hides', async () => {
    queryAlterRegistry.registerAs(OWNER, `zvd_${PARENT}`, (qb: any) =>
      qb.where('title', '<>', 'parent-row'),
    );
    expect(await expandedParent('?expand=parent')).toBeUndefined();
  });

  it('does not expand a target row entity access denies, on list and single', async () => {
    entityAccessRegistry.registerAs(OWNER, `zvd_${PARENT}`, () => 'deny');
    expect(await expandedParent('?expand=parent')).toBeUndefined();
    const childId = (
      await sql<{ id: string }>`SELECT id FROM ${sql.id(`zvd_${CHILD}`)} LIMIT 1`.execute(db)
    ).rows[0]!.id;
    expect(await expandedParent(`/${childId}?expand=parent`)).toBeUndefined();
  });
});
