/**
 * Phase C — PATCH + DELETE entity-access deny (handlers/single.ts).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { entityAccessRegistry } from '../../lib/tenancy/entity-access.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hpdel_${Date.now()}`;
const OWNER = 'harness-patch-delete-entity-access';

d('data single PATCH/DELETE entity access (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let tableName = '';
  let recordId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
    tableName = `zvd_${COLLECTION}`;

    const create = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'locked-row' }),
    });
    expect(create.status).toBe(201);
    recordId = ((await create.json()) as { id: string }).id;
  });

  afterEach(() => entityAccessRegistry.unregisterAll(OWNER));

  afterAll(async () => {
    if (!db) return;
    entityAccessRegistry.unregisterAll(OWNER);
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

  it('returns 403 on PATCH when entity-access denies update', async () => {
    entityAccessRegistry.scope(OWNER).register({
      table: tableName,
      check: (_record, _user, op) => (op === 'update' ? 'deny' : 'allow'),
    });

    const res = await app.request(`/api/data/${COLLECTION}/${recordId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'nope' }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 403 on DELETE when entity-access denies delete', async () => {
    entityAccessRegistry.scope(OWNER).register({
      table: tableName,
      check: (_record, _user, op) => (op === 'delete' ? 'deny' : 'allow'),
    });

    const res = await app.request(`/api/data/${COLLECTION}/${recordId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(403);
  });
});
