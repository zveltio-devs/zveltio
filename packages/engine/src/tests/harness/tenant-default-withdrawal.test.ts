/**
 * A withdrawal from the default tenant is a withdrawal (ledger A14).
 *
 * The membership gate returned `next()` for the default tenant before any
 * check, so a user whose every `zv_tenant_users` row there had lapsed
 * (`valid_to` passed: the reach is NO_UNITS) reached every handler, and only
 * RLS refused their writes later — a handler that read or cached before that
 * ran under the narrowed reach (#1586). Their API key acted there too: a root
 * key in the default tenant never asked about its issuer.
 *
 * A user with NO row in the default tenant is the plain single-tenant case,
 * every authenticated user implicitly a member: unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import { DEFAULT_TENANT_ID, stillInTenant } from '../../lib/tenancy/index.js';
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
const COLL = `dtw_${SFX}`;
const KEY_NAME = `dtw-${SFX}`;

d('the default tenant refuses a withdrawn member', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  const m: Record<'lapsed' | 'none' | 'active', { cookie: string; userId: string }> = {} as never;

  const enroll = (userId: string, to: string | null) =>
    sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role, valid_from, valid_to)
        VALUES (${DEFAULT_TENANT_ID}::uuid, ${userId}, 'member', now() - interval '2 days',
                ${to === null ? null : sql`now() + ${to}::interval`})
        ON CONFLICT (tenant_id, user_id) DO UPDATE SET valid_to = EXCLUDED.valid_to`.execute(db);

  async function mintKey(createdBy: string) {
    const key = generateApiKey();
    await db
      .insertInto('zv_api_keys')
      .values({
        name: KEY_NAME,
        key_hash: await hashApiKey(key),
        key_prefix: key.substring(0, 12),
        scopes: sql`${JSON.stringify([{ collection: COLL, actions: ['read'] }])}::jsonb`,
        created_by: createdBy,
        is_active: true,
        tenant_id: DEFAULT_TENANT_ID,
      } as never)
      .execute();
    return key;
  }

  const get = (path: string, headers: Record<string, string>) => app.request(path, { headers });
  const code = async (res: Response) => ((await res.json()) as { code?: string }).code;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLL,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    const grants = [{ collection: COLL, actions: ['read'] }];
    for (const k of ['lapsed', 'none', 'active'] as const) {
      m[k] = await createMemberSession(app, db, { grants });
      await asKeyIssuer(m[k].userId);
    }
    await enroll(m.lapsed.userId, '-1 day');
    await enroll(m.active.userId, null);
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_api_keys WHERE name = ${KEY_NAME}`.execute(db).catch(() => {});
    await sql`DELETE FROM zv_tenant_users WHERE user_id = ANY(${Object.values(m).map((x) => x.userId)})`
      .execute(db)
      .catch(() => {});
    await dropTestCollection(db, COLL).catch(() => {});
  });

  it('refuses a session whose every default-tenant membership lapsed', async () => {
    const res = await get(`/api/data/${COLL}`, { cookie: m.lapsed.cookie });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('tenant.membership_required');
  });

  it('admits a user with no row there, a member in force and a god', async () => {
    for (const cookie of [m.none.cookie, m.active.cookie, god]) {
      expect((await get(`/api/data/${COLL}`, { cookie })).status).toBe(200);
    }
  });

  it('gives a route without a request transaction the same answer', async () => {
    // `/api/collections` is in TXN_SKIP_PREFIXES: no reach is resolved there.
    const lapsed = await get('/api/collections', { cookie: m.lapsed.cookie });
    expect(lapsed.status).toBe(403);
    expect(await code(lapsed)).toBe('tenant.membership_required');
    const none = await get('/api/collections', { cookie: m.none.cookie });
    expect(none.status).not.toBe(403);
  });

  it("refuses the withdrawn member's own key; a key never exceeds its issuer", async () => {
    expect(
      (await get(`/api/data/${COLL}`, { 'X-API-Key': await mintKey(m.lapsed.userId) })).status,
    ).toBe(401);
    expect(
      (await get(`/api/data/${COLL}`, { 'X-API-Key': await mintKey(m.none.userId) })).status,
    ).toBe(200);
    expect(
      (await get(`/api/data/${COLL}`, { 'X-API-Key': await mintKey(m.active.userId) })).status,
    ).toBe(200);
  });

  it('closes an open realtime connection once the withdrawal lands', async () => {
    const conn = (userId: string) => ({
      tenantId: DEFAULT_TENANT_ID,
      principal: { kind: 'session', userId },
    });
    const held = await stillInTenant(db, [
      conn(m.lapsed.userId),
      conn(m.none.userId),
      conn(m.active.userId),
    ]);
    expect(held(conn(m.lapsed.userId))).toBe(false);
    expect(held(conn(m.none.userId))).toBe(true);
    expect(held(conn(m.active.userId))).toBe(true);
  });
});
