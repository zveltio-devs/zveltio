/**
 * Phase C — full collection DDL lifecycle via HTTP routes (batch-128 pattern).
 *
 * POST create → POST add-field → DELETE field → PATCH metadata → DELETE drop.
 * Drives ddl-queue + ddl-manager + routes/collections.ts end-to-end on Postgres.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hfull_${Date.now()}`;

d('collections full DDL route lifecycle (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  it('POST / creates, mutates fields, updates metadata, and drops the collection', async () => {
    const create = await app.request('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: COLLECTION,
        display_name: 'Full Lifecycle',
        fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
      }),
    });
    expect(create.status).toBe(202);
    expect(await DDLManager.tableExists(db, COLLECTION)).toBe(true);

    const addField = await app.request(`/api/collections/${COLLECTION}/fields`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: 'notes',
        type: 'text',
        required: false,
        unique: false,
        indexed: false,
      }),
    });
    expect([200, 201, 202]).toContain(addField.status);

    const patchMeta = await app.request(`/api/collections/${COLLECTION}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ displayName: 'Renamed Full', icon: 'Box' }),
    });
    expect([200, 202, 204]).toContain(patchMeta.status);

    const delField = await app.request(`/api/collections/${COLLECTION}/fields/notes`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(delField.status).toBe(200);

    const sync = await app.request(`/api/collections/${COLLECTION}/sync-schema`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(sync.status).toBe(200);

    const drop = await app.request(`/api/collections/${COLLECTION}?force=true`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(drop.status).toBe(200);
    expect(await DDLManager.tableExists(db, COLLECTION)).toBe(false);
  });
});
