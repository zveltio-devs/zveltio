/**
 * Relations — Integration Tests
 *
 * Tests relation creation, listing, filtering, update, and delete.
 * Requires two existing collections (created via /api/collections) and a god session.
 * Requires TEST_DATABASE_URL and a running engine on TEST_PORT.
 *
 * Run with:
 * TEST_DATABASE_URL=postgresql://... TEST_PORT=3099 bun test packages/engine/src/tests/integration/relations.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { sql } from 'kysely';
import { createDb } from '../../db/index.js';
import type { Database } from '../../db/index.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const TEST_PORT = process.env.TEST_PORT || '3099';
const BASE_URL = `http://localhost:${TEST_PORT}`;
const skipAll = !TEST_DB_URL;

const TS = Date.now();
const COL_A = `rel_a_${TS}`;
const COL_B = `rel_b_${TS}`;

let db: Database;
let godCookie: string;
let regularCookie: string;
let relationId: string;

async function createCollection(name: string, cookie: string): Promise<void> {
  await fetch(`${BASE_URL}/api/collections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      name,
      fields: [{ name: 'title', type: 'text', required: true }],
    }),
  });
  // Wait briefly for async DDL job
  await new Promise((r) => setTimeout(r, 800));
}

beforeAll(async () => {
  if (skipAll) return;
  db = createDb(TEST_DB_URL!);

  // God user
  const godEmail = `god-rel-${TS}@test.local`;
  await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: godEmail, password: 'GodPass123!', name: 'Rel God' }),
  });
  await sql`UPDATE "user" SET role = 'god' WHERE email = ${godEmail}`.execute(db);
  const godRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: godEmail, password: 'GodPass123!' }),
  });
  godCookie = godRes.headers.get('set-cookie') ?? '';

  // Regular user (for 401/403 tests)
  const regEmail = `reg-rel-${TS}@test.local`;
  await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: regEmail, password: 'RegPass123!', name: 'Rel Regular' }),
  });
  const regRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: regEmail, password: 'RegPass123!' }),
  });
  regularCookie = regRes.headers.get('set-cookie') ?? '';

  // Create two test collections to relate
  await createCollection(COL_A, godCookie);
  await createCollection(COL_B, godCookie);
});

afterAll(async () => {
  if (skipAll || !db) return;
  // Drop test collections
  await sql`DROP TABLE IF EXISTS ${sql.id(COL_A)}`.execute(db).catch(() => {});
  await sql`DROP TABLE IF EXISTS ${sql.id(COL_B)}`.execute(db).catch(() => {});
  await db.destroy().catch(() => {});
});

describe.skipIf(skipAll)('Relations — Integration', () => {
  it('GET /api/relations — returns 401 unauthenticated', async () => {
    const res = await fetch(`${BASE_URL}/api/relations`);
    expect(res.status).toBe(401);
  });

  it('GET /api/relations — returns 401/403 for non-admin', async () => {
    const res = await fetch(`${BASE_URL}/api/relations`, {
      headers: { Cookie: regularCookie },
    });
    expect(res.status).toBeOneOf([401, 403]);
  });

  it('GET /api/relations — lists all relations (god)', async () => {
    const res = await fetch(`${BASE_URL}/api/relations`, {
      headers: { Cookie: godCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.relations)).toBe(true);
  });

  it('POST /api/relations — creates a m2o relation (201)', async () => {
    const res = await fetch(`${BASE_URL}/api/relations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: godCookie },
      body: JSON.stringify({
        name: `rel_${TS}`,
        type: 'm2o',
        source_collection: COL_A,
        source_field: 'b_id',
        target_collection: COL_B,
        target_field: 'id',
        on_delete: 'SET NULL',
        on_update: 'CASCADE',
      }),
    });
    expect(res.status).toBeOneOf([200, 201, 202]);
    const body = await res.json() as any;
    const relation = body.relation ?? body;
    expect(relation).toHaveProperty('id');
    relationId = relation.id;
  });

  it('POST /api/relations — rejects duplicate source field', async () => {
    const res = await fetch(`${BASE_URL}/api/relations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: godCookie },
      body: JSON.stringify({
        name: `rel_dup_${TS}`,
        type: 'm2o',
        source_collection: COL_A,
        source_field: 'b_id', // same field as above
        target_collection: COL_B,
        target_field: 'id',
      }),
    });
    expect(res.status).toBeOneOf([400, 409]);
  });

  it('POST /api/relations — returns 404 for non-existent collection', async () => {
    const res = await fetch(`${BASE_URL}/api/relations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: godCookie },
      body: JSON.stringify({
        name: `rel_ghost_${TS}`,
        type: 'm2o',
        source_collection: 'nonexistent_collection',
        source_field: 'foreign_id',
        target_collection: COL_B,
        target_field: 'id',
      }),
    });
    expect(res.status).toBe(404);
  });

  it('GET /api/relations/:id — returns relation details', async () => {
    if (!relationId) return;
    const res = await fetch(`${BASE_URL}/api/relations/${relationId}`, {
      headers: { Cookie: godCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect((body.relation ?? body).id).toBe(relationId);
  });

  it('GET /api/relations?collection=:name — filters by collection', async () => {
    const res = await fetch(`${BASE_URL}/api/relations?collection=${COL_A}`, {
      headers: { Cookie: godCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.relations)).toBe(true);
  });

  it('PATCH /api/relations/:id — updates relation metadata', async () => {
    if (!relationId) return;
    const res = await fetch(`${BASE_URL}/api/relations/${relationId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: godCookie },
      body: JSON.stringify({ on_delete: 'CASCADE' }),
    });
    expect(res.status).toBeOneOf([200, 204]);
  });

  it('DELETE /api/relations/:id — removes the relation', async () => {
    if (!relationId) return;
    const res = await fetch(`${BASE_URL}/api/relations/${relationId}`, {
      method: 'DELETE',
      headers: { Cookie: godCookie },
    });
    expect(res.status).toBeOneOf([200, 204]);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
  });
});
