/**
 * A root-tenant API key (`tenant_id` = the default tenant) used in an ordinary tenant.
 *
 * `apiKeyActsIn` let a root key (tenant NULL or the default tenant) act in
 * every tenant without asking whether its issuer belonged there. A member the
 * membership middleware refused by session in tenant T (403
 * `tenant.membership_required`) sent their own root key with T's slug and read
 * T's data. A root key now acts in T on its issuer's standing there, the rule
 * sessions meet: god, or a membership in force.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/index.js';
import {
  asKeyIssuer,
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const COLLECTION = `rootkey_${SFX}`;
const T = { id: crypto.randomUUID(), slug: `rootkey-${SFX.replace('_', '-')}` };
const KEY_NAME = `rootkey-${SFX}`;

d('a root-tenant API key in an ordinary tenant', () => {
  let app: Hono;
  let db: Database;
  let godId = '';
  let outsider = { cookie: '', userId: '' };
  let insider = '';

  async function mintKey(createdBy: string) {
    const key = generateApiKey();
    await db
      .insertInto('zv_api_keys')
      .values({
        name: KEY_NAME,
        key_hash: await hashApiKey(key),
        key_prefix: key.substring(0, 12),
        scopes: sql`${JSON.stringify([{ collection: COLLECTION, actions: ['read'] }])}::jsonb`,
        created_by: createdBy,
        is_active: true,
        tenant_id: DEFAULT_TENANT_ID,
      } as never)
      .execute();
    return key;
  }

  const list = (headers: Record<string, string>, inTenant = true) =>
    app.request(`/api/data/${COLLECTION}`, {
      headers: { ...headers, ...(inTenant ? { 'x-tenant-slug': T.slug } : {}) },
    });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    await createGodSession(app, db);
    godId = (
      await sql<{ id: string }>`SELECT id FROM "user" WHERE role = 'god' LIMIT 1`.execute(db)
    ).rows[0]!.id;
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${T.id}::uuid, ${T.slug}, 'rootkey', 'active')`.execute(db);
    outsider = await createMemberSession(app, db);
    await asKeyIssuer(outsider.userId);
    insider = await asKeyIssuer((await createMemberSession(app, db)).userId);
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role)
              VALUES (${T.id}::uuid, ${insider}, 'member')`.execute(db);
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_api_keys WHERE name = ${KEY_NAME}`.execute(db).catch(() => {});
    await dropTestCollection(db, COLLECTION).catch(() => {});
    await sql`DELETE FROM zv_tenant_users WHERE tenant_id = ${T.id}::uuid`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zv_tenants WHERE id = ${T.id}::uuid`.execute(db).catch(() => {});
  });

  it('refuses a non-member by session and by their own root key', async () => {
    const rootKey = await mintKey(outsider.userId);

    const session = await list({ cookie: outsider.cookie });
    expect(session.status).toBe(403);
    expect(((await session.json()) as { code?: string }).code).toBe('tenant.membership_required');

    // Refused at the key door, as a key whose issuer left its tenant is.
    expect((await list({ 'X-API-Key': rootKey })).status).toBe(401);

    // Root, where everyone counts, is unchanged.
    expect((await list({ 'X-API-Key': rootKey }, false)).status).toBe(200);
  }, 60_000);

  it('admits a member of the tenant and a god, and stops at a withdrawal', async () => {
    const memberKey = await mintKey(insider);
    const godKey = await mintKey(godId);
    expect((await list({ 'X-API-Key': memberKey })).status).toBe(200);
    expect((await list({ 'X-API-Key': godKey })).status).toBe(200);

    // Withdrawal is a date and is read uncached: the next request is refused.
    await sql`UPDATE zv_tenant_users SET valid_to = now() - interval '1 second'
              WHERE tenant_id = ${T.id}::uuid AND user_id = ${insider}`.execute(db);
    expect((await list({ 'X-API-Key': memberKey })).status).toBe(401);
  }, 60_000);
});
