/**
 * `GET /api/data` lists the collections the caller may read, with the fields
 * they may see — the App's navigation and generic screens (ADR 0006) are built
 * from it, so it must answer with the same gates `GET /api/data/:collection`
 * runs: no grant, no collection; a hidden column, no field.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { invalidateColumnPermCache } from '../../lib/tenancy/column-permissions.js';
import {
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const OPEN = `hreadable_${STAMP}`;
const CLOSED = `hunreadable_${STAMP}`;

type Listed = {
  name: string;
  display_name: string | null;
  virtual_config?: unknown;
  fields: { name: string; type: string; readonly?: boolean }[];
};

d('GET /api/data lists what the caller may read', () => {
  let app: Hono;
  let db: Database;
  let member = '';

  const create = (name: string) =>
    DDLManager.createCollection(db, {
      name,
      displayName: 'Readable',
      adoptRules: true,
      fields: ['title', 'salary', 'locked'].map((f) => ({
        name: f,
        type: 'text',
        required: false,
        unique: false,
        indexed: false,
      })),
    } as never);

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    await create(OPEN);
    await create(CLOSED);
    ({ cookie: member } = await createMemberSession(app, db, {
      grants: [{ collection: OPEN, actions: ['read'] }],
    }));
    await db
      .insertInto('zvd_column_permissions')
      .values([
        {
          collection_name: OPEN,
          column_name: 'salary',
          role: 'member',
          can_read: false,
          can_write: false,
        },
        {
          collection_name: OPEN,
          column_name: 'locked',
          role: 'member',
          can_read: true,
          can_write: false,
        },
      ])
      .execute();
    await invalidateColumnPermCache(OPEN);
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await db.deleteFrom('zvd_column_permissions').where('collection_name', '=', OPEN).execute();
    await invalidateColumnPermCache(OPEN);
    await dropTestCollection(db, OPEN);
    await dropTestCollection(db, CLOSED);
  });

  it('refuses without a session', async () => {
    expect((await app.request('/api/data')).status).toBe(401);
  });

  it('lists the granted collection with only its visible fields', async () => {
    const res = await app.request('/api/data', { headers: { cookie: member } });
    expect(res.status).toBe(200);
    const { collections } = (await res.json()) as { collections: Listed[] };
    const names = collections.map((c) => c.name);
    expect(names).toContain(OPEN);
    expect(names).not.toContain(CLOSED);

    const open = collections.find((c) => c.name === OPEN)!;
    expect(open.display_name).toBe('Readable');
    expect('virtual_config' in open).toBe(false);
    const fields = Object.fromEntries(open.fields.map((f) => [f.name, f]));
    expect(fields.title).toBeDefined();
    expect(fields.title!.readonly).toBeUndefined();
    expect(fields.salary).toBeUndefined();
    expect(fields.locked!.readonly).toBe(true);
  });
});
