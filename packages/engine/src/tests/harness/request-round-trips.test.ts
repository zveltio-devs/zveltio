/**
 * What a member's `GET /api/data/:collection` costs in statements, end to end.
 *
 * #912 folded the tenant reach into the `set_config` statement. Two lookups
 * were still paid on every request before the handler's first query:
 *   - the tenant row by slug, uncached when Valkey is absent (every
 *     single-tenant install without a cache, the default tenant included);
 *   - a second membership query in `tenantMembershipMiddleware`, asking what
 *     the reach just resolved.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getEnforcer, invalidateUserPermCache } from '../../lib/tenancy/index.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TAG = `${Date.now()}`.slice(-9);
const T = { id: crypto.randomUUID(), slug: `rrt-${TAG}` };
const COLL = `rrt_${TAG}`;

d('per-request round trips', () => {
  let app: Hono;
  let db: Database;
  let member: { cookie: string; userId: string };
  type Execute = (this: object, q: { sql?: string }) => Promise<unknown>;
  let proto: { executeQuery: Execute } | null = null;
  let original: Execute = async () => undefined;
  let log: string[] | null = null;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    const god = await createGodSession(app, db);
    const created = await app.request('/api/collections', {
      method: 'POST',
      headers: { cookie: god, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: COLL,
        fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
      }),
    });
    expect([200, 201, 202]).toContain(created.status);
    for (let i = 0; i < 200; i++) {
      const r = await sql<{
        t: string | null;
      }>`SELECT to_regclass(${`zvd_${COLL}`})::text AS t`.execute(db);
      if (r.rows[0]?.t) break;
      await Bun.sleep(50);
    }
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${T.id}::uuid, ${T.slug}, 'rrt', 'active')`.execute(db);
    member = await createMemberSession(app, db);
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role)
              VALUES (${T.id}::uuid, ${member.userId}, 'member')`.execute(db);
    const e = await getEnforcer();
    await e.addPolicy(member.userId, T.id, COLL, 'read');
    await invalidateUserPermCache(member.userId);

    const probe = await db.getExecutor().provideConnection(async (c) => c);
    const patched = Object.getPrototypeOf(probe) as { executeQuery: Execute };
    proto = patched;
    original = patched.executeQuery;
    patched.executeQuery = function (this: object, q: { sql?: string }) {
      log?.push(
        String(q?.sql ?? '')
          .replace(/\s+/g, ' ')
          .slice(0, 140),
      );
      return original.call(this, q);
    };
  }, 60_000);

  afterAll(async () => {
    if (proto) proto.executeQuery = original;
    if (!db) return;
    await sql`DELETE FROM zv_tenant_users WHERE tenant_id = ${T.id}::uuid`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id = ${T.id}::uuid`.execute(db);
  });

  async function statements(headers: Record<string, string>): Promise<string[]> {
    const go = () =>
      app.request(`/api/data/${COLL}`, { headers: { cookie: member.cookie, ...headers } });
    // Warm: caches a request legitimately keeps are filled by the first one.
    expect((await go()).status).toBe(200);
    log = [];
    const res = await go();
    const seen = log;
    log = null;
    expect(res.status).toBe(200);
    return seen;
  }

  it('a member of a tenant pays no slug lookup and no second membership query', async () => {
    const seen = await statements({ 'x-tenant-slug': T.slug });
    console.log(`[round-trips] tenant member: ${seen.length}\n  ${seen.join('\n  ')}`);
    expect(seen.filter((s) => /from "zv_tenants"/i.test(s) && /"slug"/.test(s))).toEqual([]);
    expect(seen.filter((s) => /from "zv_tenant_users"/i.test(s))).toEqual([]);
  });

  it('the membership answer still refuses a non-member and a lapsed one', async () => {
    const outsider = await createMemberSession(app, db);
    const lapsed = await createMemberSession(app, db);
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role, valid_from, valid_to)
              VALUES (${T.id}::uuid, ${lapsed.userId}, 'member', now() - interval '2 days',
                      now() - interval '1 day')`.execute(db);
    for (const who of [outsider, lapsed]) {
      const res = await app.request(`/api/data/${COLL}`, {
        headers: { cookie: who.cookie, 'x-tenant-slug': T.slug },
      });
      expect(res.status).toBe(403);
    }
  });

  it('a suspended tenant is refused at once, cached row or not', async () => {
    const god = await createGodSession(app, db);
    const go = () =>
      app.request(`/api/data/${COLL}`, {
        headers: { cookie: member.cookie, 'x-tenant-slug': T.slug },
      });
    expect((await go()).status).toBe(200);
    const patch = await app.request(`/api/tenants/${T.id}`, {
      method: 'PATCH',
      headers: { cookie: god, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'suspended' }),
    });
    expect(patch.status).toBe(200);
    expect((await go()).status).not.toBe(200);
  });
});
