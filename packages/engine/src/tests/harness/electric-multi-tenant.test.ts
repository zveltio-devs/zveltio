/**
 * Electric is refused on an instance with more than one tenant.
 *
 * The client syncs straight from the Electric service, which streams a
 * published table through logical replication: no engine read gate runs on
 * that stream, and nothing in it is filtered by tenant. So the engine must not
 * hand out the token that opens it while two tenants share the tables.
 *
 * Measured before the repair: a member of tenant A, with a row of tenant B in
 * the same collection, got `200` and a signed token.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TAG = `${Date.now()}`;
const COLL = `helectric_${TAG}`;
const A = { id: crypto.randomUUID(), slug: `elec-a-${TAG}` };
const B = { id: crypto.randomUUID(), slug: `elec-b-${TAG}` };

d('electric on a multi-tenant instance', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  const env = { url: process.env.ELECTRIC_URL, token: process.env.ELECTRIC_AUTH_TOKEN };
  const asA = () => ({ cookie, 'x-tenant-slug': A.slug, 'Content-Type': 'application/json' });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    process.env.ELECTRIC_URL = 'wss://electric.test:5133';
    process.env.ELECTRIC_AUTH_TOKEN = 'harness-shared-secret';
    for (const t of [A, B]) {
      await sql`INSERT INTO zv_tenants (id, slug, name, status)
                VALUES (${t.id}::uuid, ${t.slug}, 'electric', 'active')`.execute(db);
    }
    await DDLManager.createCollection(db, {
      name: COLL,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    for (const t of [A, B]) {
      await sql`INSERT INTO ${sql.id(`zvd_${COLL}`)} (tenant_id, title)
                VALUES (${t.id}::uuid, ${t.slug})`.execute(db);
    }
    const m = await createMemberSession(app, db, {
      grants: [{ collection: COLL, actions: ['read'] }],
    });
    cookie = m.cookie;
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role)
              VALUES (${A.id}::uuid, ${m.userId}, 'member')`.execute(db);
  }, 120_000);

  afterAll(async () => {
    if (env.url === undefined) delete process.env.ELECTRIC_URL;
    else process.env.ELECTRIC_URL = env.url;
    if (env.token === undefined) delete process.env.ELECTRIC_AUTH_TOKEN;
    else process.env.ELECTRIC_AUTH_TOKEN = env.token;
    if (!db) return;
    await dropTestCollection(db, COLL).catch(() => {});
    await sql`DELETE FROM zv_tenant_users WHERE tenant_id IN (${A.id}::uuid, ${B.id}::uuid)`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zv_tenants WHERE id IN (${A.id}::uuid, ${B.id}::uuid)`
      .execute(db)
      .catch(() => {});
  });

  it('the member reads only tenant A through the data API (the setup is real)', async () => {
    const res = await app.request(`/api/data/${COLL}`, { headers: asA() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: { title: string }[] };
    expect(body.records.map((r) => r.title)).toEqual([A.slug]);
  });

  it('POST /api/electric/auth mints no token and names the reason', async () => {
    const res = await app.request('/api/electric/auth', {
      method: 'POST',
      headers: asA(),
      body: JSON.stringify({ tables: [`zvd_${COLL}`] }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(409);
    expect(body.token).toBeUndefined();
    expect(body.code).toBe('electric.multi_tenant');
    expect(String(body.detail)).toMatch(/more than one tenant/);
  });

  it('GET /api/electric/config does not advertise the service', async () => {
    const res = await app.request('/api/electric/config', { headers: asA() });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(409);
    expect(body.code).toBe('electric.multi_tenant');
    expect(body.electricUrl).toBeUndefined();
  });
});
