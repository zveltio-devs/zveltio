/**
 * Tenant A sees nothing of tenant B — on every door, in one table.
 *
 * Isolation is FORCE row-level security keyed on the request's tenant, and
 * most doors already have a test of their own. What none of them says is that
 * the list is complete. This file is the list: every route under the prefixes
 * that serve tenant data is a row in `DOORS`, and each row is either probed
 * here with two real tenants, pointed at the test that probes it, or exempt
 * with a reason. A route added under one of those prefixes with no row fails
 * the first test below, the way `check-gate-coverage` refuses a gate with no
 * planted proof — so a new door cannot ship unexamined.
 *
 * The probes run as a member of A, with B's rows really present in the same
 * tables (written through the API by a member of B), and look for B's marker in
 * whatever A gets back. The links between them are forged in the database —
 * an A row pointing at a B row — because that is the shape an expansion or a
 * join would leak through. docs/platform/tenant-isolation.md lists the same
 * doors for readers; change it with this table.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import { getEnforcer, invalidateUserPermCache } from '../../lib/tenancy/index.js';
import { _wsPermCacheForTests, websocketHandler } from '../../routes/ws.js';
import {
  createGodSession,
  createKeyCreator,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
  wsUpgradeData,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TAG = `${Date.now()}`.slice(-8) + `${Math.floor(Math.random() * 1e4)}`;
const A = { id: crypto.randomUUID(), slug: `doors-a-${TAG}` };
const B = { id: crypto.randomUUID(), slug: `doors-b-${TAG}` };
const P = `drs_p_${TAG}`; // parent: m2m tags, o2m children
const C = `drs_c_${TAG}`; // child: m2o parent
const T = `drs_t_${TAG}`; // tag
const MARK = `B-SECRET-${TAG}`;
const KEY = generateApiKey();

type Coverage = { here: true } | { elsewhere: string } | { exempt: string } | { todo: string };

const here = { here: true } as const;
const at = (file: string): Coverage => ({ elsewhere: file });
const exempt = (why: string): Coverage => ({ exempt: why });
const todo = (what: string): Coverage => ({ todo: what });

const MIDDLEWARE = exempt(
  'middleware (rate limits, preview environment, slow-query log), no handler',
);
const OWN_USER = exempt("the caller's own rows (user_id), not a tenant's");

/**
 * Every route under `PREFIXES`, by `METHOD path` as Hono registers it.
 *
 * `here`: probed in this file. `elsewhere`: a test that asserts the other
 * tenant's row is refused or absent. `exempt`: why it is not a tenant door.
 * `todo`: a door no test asserts yet — listed so it stays visible.
 */
const DOORS: Record<string, Coverage> = {
  // ── Data API ────────────────────────────────────────────────────────────
  'GET /api/data/:collection': here,
  'GET /api/data/:collection/:id': here,
  'POST /api/data/:collection': here,
  'PATCH /api/data/:collection/:id': here,
  'PUT /api/data/:collection/:id': here,
  'DELETE /api/data/:collection/:id': here,
  'POST /api/data/:collection/bulk': here,
  'PATCH /api/data/:collection/bulk': here,
  'DELETE /api/data/:collection/bulk': here,
  'POST /api/data/*': MIDDLEWARE,
  'PUT /api/data/*': MIDDLEWARE,
  'PATCH /api/data/*': MIDDLEWARE,
  'DELETE /api/data/*': MIDDLEWARE,
  // ── Offline sync ────────────────────────────────────────────────────────
  'POST /api/sync/pull': here,
  'POST /api/sync/push': here,
  'POST /api/sync/*': MIDDLEWARE,
  'PUT /api/sync/*': MIDDLEWARE,
  'PATCH /api/sync/*': MIDDLEWARE,
  'DELETE /api/sync/*': MIDDLEWARE,
  // ── Realtime ────────────────────────────────────────────────────────────
  'GET /api/realtime/stream': here,
  'GET /api/ws': here,
  'GET /api/ws/info': exempt('static endpoint description, no tenant data'),
  'GET /api/ws/stats': todo('connection counts: assert a tenant admin of A sees only A'),
  'GET /api/realtime/connections': todo('assert a tenant admin of A lists only A connections'),
  'GET /api/realtime/presence/:channel': at('realtime-channel-routes.test.ts'),
  'POST /api/realtime/presence/:channel': at('realtime-channel-routes.test.ts'),
  'DELETE /api/realtime/presence/:channel': at('realtime-channel-routes.test.ts'),
  'POST /api/realtime/broadcast/:channel': at('realtime-channel-routes.test.ts'),
  'POST /api/realtime/publish': todo('assert a publish in B reaches no subscriber in A'),
  // ── Revisions and comments ──────────────────────────────────────────────
  'GET /api/revisions': at('revisions-tenant-isolation.test.ts'),
  'GET /api/revisions/:id': here,
  'POST /api/revisions/:id/revert': here,
  'GET /api/revisions/record/:collection/:recordId/comments': here,
  'POST /api/revisions/record/:collection/:recordId/comments': here,
  'DELETE /api/revisions/record/comments/:commentId': here,
  // ── Storage and files ───────────────────────────────────────────────────
  'GET /api/storage': at('storage-tenant-isolation.test.ts'),
  'GET /api/storage/:id': at('storage-tenant-isolation.test.ts'),
  'DELETE /api/storage/:id': at('storage-tenant-isolation.test.ts'),
  'GET /api/storage/:id/signed-url': here,
  'GET /api/storage/:id/transform': here,
  'GET /api/storage/folders': here,
  'POST /api/storage/folders': here,
  'POST /api/storage/upload': todo('assert an upload lands in the request tenant'),
  'GET /files/*': todo('assert a B object path is not served to A (signed and public)'),
  // ── API keys ────────────────────────────────────────────────────────────
  'GET /api/api-keys': at('api-keys-tenant-isolation.test.ts'),
  'POST /api/api-keys': at('api-keys-tenant-isolation.test.ts'),
  'DELETE /api/api-keys/:id': at('api-keys-tenant-isolation.test.ts'),
  'GET /api/api-keys/self': exempt('the presenting key itself'),
  'PUT /api/api-keys/:id/rate-limit': at('api-keys-tenant-isolation.test.ts'),
  'DELETE /api/api-keys/:id/rate-limit': at('api-keys-tenant-isolation.test.ts'),
  // ── Webhooks ────────────────────────────────────────────────────────────
  'GET /api/webhooks': at('webhooks-tenant-isolation.test.ts'),
  'POST /api/webhooks': at('webhooks-tenant-isolation.test.ts'),
  'GET /api/webhooks/:id': at('webhooks-tenant-isolation.test.ts'),
  'PATCH /api/webhooks/:id': at('webhooks-tenant-isolation.test.ts'),
  'DELETE /api/webhooks/:id': at('webhooks-tenant-isolation.test.ts'),
  'POST /api/webhooks/:id/rotate-secret': at('webhooks-tenant-isolation.test.ts'),
  'GET /api/webhooks/:id/deliveries': at('webhooks-tenant-isolation.test.ts'),
  'POST /api/webhooks/:id/test': at('webhooks-tenant-isolation.test.ts'),
  'GET /api/webhooks/dlq': at('webhooks-tenant-isolation.test.ts'),
  'POST /api/webhooks/dlq/replay': at('webhooks-tenant-isolation.test.ts'),
  // ── Flows ───────────────────────────────────────────────────────────────
  'GET /api/flows': at('flows-tenant-isolation.test.ts'),
  'POST /api/flows': at('flows-tenant-isolation.test.ts'),
  'GET /api/flows/:id': at('flows-tenant-isolation.test.ts'),
  'PATCH /api/flows/:id': at('flows-tenant-isolation.test.ts'),
  'DELETE /api/flows/:id': at('flows-tenant-isolation.test.ts'),
  'POST /api/flows/:id/run': at('flows-tenant-isolation.test.ts'),
  'GET /api/flows/:id/runs': at('flows-tenant-isolation.test.ts'),
  'GET /api/flows/runs/:runId': at('flows-tenant-isolation.test.ts'),
  'POST /api/flows/:id/steps': at('flows-tenant-isolation.test.ts'),
  'PUT /api/flows/:id/steps/:stepId': at('flows-tenant-isolation.test.ts'),
  'DELETE /api/flows/:id/steps/:stepId': at('flows-tenant-isolation.test.ts'),
  'GET /api/flows/dlq': at('flows-tenant-isolation.test.ts'),
  'POST /api/flows/dlq/:id/retry': at('flows-tenant-isolation.test.ts'),
  // ── Insights and saved queries ──────────────────────────────────────────
  'GET /api/insights/dashboards': at('dashboards-tenant-isolation.test.ts'),
  'POST /api/insights/dashboards': at('dashboards-tenant-isolation.test.ts'),
  'GET /api/insights/dashboards/:id': at('dashboards-tenant-isolation.test.ts'),
  'DELETE /api/insights/dashboards/:id': at('dashboards-tenant-isolation.test.ts'),
  'GET /api/insights/dashboards/:id/shares': todo("assert B's shares are not listed to A"),
  'POST /api/insights/dashboards/:id/shares': todo("assert A cannot share B's dashboard"),
  'DELETE /api/insights/dashboards/:id/shares/:shareId': todo("assert A cannot unshare B's"),
  'POST /api/insights/dashboards/:id/panels': todo("assert A cannot add a panel to B's"),
  'PATCH /api/insights/panels/:id': todo("assert A cannot change B's panel"),
  'DELETE /api/insights/panels/:id': todo("assert A cannot delete B's panel"),
  'POST /api/insights/panels/:id/execute': todo("assert A cannot run B's panel"),
  'POST /api/insights/query': todo('assert an ad-hoc query in A reads no B rows'),
  'GET /api/insights/saved-queries': at('insights-role-share-visibility.test.ts'),
  'POST /api/insights/saved-queries': todo('assert a saved query lands in A'),
  'PATCH /api/insights/saved-queries/:id': todo("assert A cannot change B's"),
  'DELETE /api/insights/saved-queries/:id': todo("assert A cannot delete B's"),
  'POST /api/insights/saved-queries/:id/execute': todo("assert A cannot run B's"),
  'GET /api/insights/subscriptions': todo("assert B's subscriptions are not listed to A"),
  'POST /api/insights/subscriptions': todo('assert a subscription lands in A'),
  'DELETE /api/insights/subscriptions/:id': todo("assert A cannot delete B's"),
  'GET /api/insights/stats': exempt('instance administrators only (requireInstanceAdmin)'),
  'GET /api/saved-queries': at('saved-queries-import-tenant-isolation.test.ts'),
  'GET /api/saved-queries/:id': at('saved-queries-import-tenant-isolation.test.ts'),
  'POST /api/saved-queries': here,
  'PUT /api/saved-queries/:id': here,
  'DELETE /api/saved-queries/:id': here,
  'POST /api/saved-queries/:id/run': here,
  'POST /api/saved-queries/execute': here,
  'POST /api/saved-queries/preview-url': exempt('builds a URL string from the body; reads no data'),
  // ── Notifications ───────────────────────────────────────────────────────
  'GET /api/notifications': OWN_USER,
  'GET /api/notifications/:id': OWN_USER,
  'DELETE /api/notifications/:id': OWN_USER,
  'DELETE /api/notifications/clear-all': OWN_USER,
  'PATCH /api/notifications/:id/read': OWN_USER,
  'PATCH /api/notifications/:id/unread': OWN_USER,
  'POST /api/notifications/mark-all-read': OWN_USER,
  'GET /api/notifications/push-tokens': OWN_USER,
  'POST /api/notifications/push-tokens': OWN_USER,
  'DELETE /api/notifications/push-tokens/:id': OWN_USER,
  'POST /api/notifications/push/subscribe': OWN_USER,
  'DELETE /api/notifications/push/subscribe': OWN_USER,
  'GET /api/notifications/push/vapid-public-key': exempt('the instance public key'),
  'POST /api/notifications/broadcast': at('tenant-membership-validity.test.ts'),
  // ── RPC ─────────────────────────────────────────────────────────────────
  'GET /api/rpc': exempt('instance administrators only (requireInstanceAdmin)'),
  'POST /api/rpc': exempt('instance administrators only (requireInstanceAdmin)'),
  'PATCH /api/rpc/:id': exempt('instance administrators only (requireInstanceAdmin)'),
  'DELETE /api/rpc/:id': exempt('instance administrators only (requireInstanceAdmin)'),
  'POST /api/rpc/:fn': here,
};

/** The prefixes that serve tenant data. A route under one of them needs a row. */
const PREFIXES = [
  '/api/data',
  '/api/sync',
  '/api/realtime',
  '/api/ws',
  '/api/revisions',
  '/api/storage',
  '/files',
  '/api/api-keys',
  '/api/webhooks',
  '/api/flows',
  '/api/insights',
  '/api/saved-queries',
  '/api/notifications',
  '/api/rpc',
];

d('tenant isolation, door by door', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  let a: { cookie: string; userId: string };
  let b: { cookie: string; userId: string };
  const probed = new Set<string>();
  const ids: Record<string, string> = {};
  const wsProbes: string[] = [];

  const asA = (extra: Record<string, string> = {}) => ({
    cookie: a.cookie,
    'x-tenant-slug': A.slug,
    ...extra,
  });
  const asB = (extra: Record<string, string> = {}) => ({
    cookie: b.cookie,
    'x-tenant-slug': B.slug,
    ...extra,
  });
  const json = { 'content-type': 'application/json' };
  const leaks = async (res: Response) => (await res.text()).includes(MARK);
  const probe = (door: string) => {
    expect(DOORS[door]).toEqual(here);
    probed.add(door);
  };
  const rowIn = async (table: string, id: string) =>
    (
      await sql<{ tenant_id: string; title: string | null }>`
        SELECT tenant_id::text, title FROM ${sql.id(`zvd_${table}`)} WHERE id = ${id}::uuid`.execute(
        db,
      )
    ).rows[0];

  async function collection(name: string, fields: unknown[]) {
    const res = await app.request('/api/collections', {
      method: 'POST',
      headers: { cookie: god, ...json },
      body: JSON.stringify({ name, display_name: name, fields }),
    });
    expect([200, 201, 202]).toContain(res.status);
    for (let i = 0; i < 200; i++) {
      const seen = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM pg_policies
         WHERE schemaname = 'public' AND tablename = ${`zvd_${name}`} AND policyname = 'tenant_isolation'
      `.execute(db);
      if (seen.rows[0]!.n > 0) return;
      await Bun.sleep(50);
    }
    throw new Error(`collection ${name} never got its policy`);
  }

  async function member(tenant: { id: string }) {
    const m = await createMemberSession(app, db);
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role)
              VALUES (${tenant.id}::uuid, ${m.userId}, 'member')`.execute(db);
    const e = await getEnforcer();
    for (const coll of [P, C, T]) {
      for (const act of ['read', 'create', 'update', 'delete']) {
        await e.addPolicy(m.userId, tenant.id, coll, act);
      }
    }
    await invalidateUserPermCache(m.userId);
    return m;
  }

  async function create(who: () => Record<string, string>, coll: string, body: object) {
    const res = await app.request(`/api/data/${coll}`, {
      method: 'POST',
      headers: { ...who(), ...json },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    const out = (await res.json()) as { data?: { id: string }; id?: string };
    return (out.data?.id ?? out.id)!;
  }

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    for (const t of [A, B]) {
      await sql`INSERT INTO zv_tenants (id, slug, name, status)
                VALUES (${t.id}::uuid, ${t.slug}, 'doors', 'active')`.execute(db);
    }
    await collection(T, [{ name: 'title', type: 'text' }]);
    await collection(P, [
      { name: 'title', type: 'text' },
      { name: 'tags', type: 'm2m', options: { related_collection: T } },
    ]);
    await collection(C, [
      { name: 'title', type: 'text' },
      { name: 'parent', type: 'm2o', options: { related_collection: P, on_delete: 'SET NULL' } },
    ]);
    const o2m = await app.request('/api/relations', {
      method: 'POST',
      headers: { cookie: god, ...json },
      body: JSON.stringify({
        name: `${P}_children`,
        type: 'o2m',
        source_collection: P,
        source_field: 'children',
        target_collection: C,
        target_field: 'owner',
        on_delete: 'SET NULL',
      }),
    });
    expect(o2m.status).toBe(201);

    a = await member(A);
    b = await member(B);

    // B's rows, written by B through the API.
    ids.pB = await create(asB, P, { title: MARK });
    ids.tB = await create(asB, T, { title: MARK });
    ids.cB = await create(asB, C, { title: MARK, parent: ids.pB });
    // A's rows.
    ids.pA = await create(asA, P, { title: `A-${TAG}` });
    ids.cA = await create(asA, C, { title: `A-${TAG}`, parent: ids.pA });
    // Forged links, as a join or an expansion would follow them: an A child
    // naming B's parent (m2o), a B child naming A's parent (o2m), and an A
    // junction row naming B's tag (m2m).
    ids.cA2 = (
      await sql<{ id: string }>`
        INSERT INTO ${sql.id(`zvd_${C}`)} (tenant_id, title, parent)
        VALUES (${A.id}::uuid, ${`A2-${TAG}`}, ${ids.pB}::uuid) RETURNING id::text`.execute(db)
    ).rows[0]!.id;
    await sql`INSERT INTO ${sql.id(`zvd_${C}`)} (tenant_id, title, owner)
              VALUES (${B.id}::uuid, ${MARK}, ${ids.pA}::uuid)`.execute(db);
    await sql`INSERT INTO ${sql.id(`zvd_jnc_${P}_${T}`)} (tenant_id, ${sql.id(`${P}_id`)}, ${sql.id(`${T}_id`)})
              VALUES (${A.id}::uuid, ${ids.pA}::uuid, ${ids.tB}::uuid)`.execute(db);

    // A key of A's member, scoped to P.
    const creator = await createKeyCreator(db, [A.id]);
    const e = await getEnforcer();
    await e.addPolicy(creator, A.id, P, 'read');
    await invalidateUserPermCache(creator);
    await sql`INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, is_active, tenant_id, created_by)
              VALUES (${`doors-${TAG}`}, ${await hashApiKey(KEY)}, ${KEY.slice(0, 12)},
                      ${JSON.stringify([{ collection: P, actions: ['read'] }])}::jsonb, true,
                      ${A.id}::uuid, ${creator})`.execute(db);
  }, 120_000);

  afterAll(async () => {
    const { connections } = _wsPermCacheForTests();
    for (const id of wsProbes) connections.delete(id);
    if (!db) return;
    await sql`DELETE FROM zv_api_keys WHERE name = ${`doors-${TAG}`}`.execute(db).catch(() => {});
    await sql`DELETE FROM zvd_rpc_functions WHERE function_name = ${`doors_fn_${TAG}`}`
      .execute(db)
      .catch(() => {});
    await sql
      .raw(`DROP FUNCTION IF EXISTS doors_fn_${TAG}()`)
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zv_saved_queries WHERE name LIKE ${`doors-%-${TAG}`}`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zv_media_files WHERE filename LIKE ${`doors-%-${TAG}`}`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zv_media_folders WHERE name LIKE ${`doors-%-${TAG}`}`
      .execute(db)
      .catch(() => {});
    for (const name of [C, P, T]) await dropTestCollection(db, name).catch(() => {});
    await sql`DROP TABLE IF EXISTS ${sql.id(`zvd_jnc_${P}_${T}`)}`.execute(db).catch(() => {});
    await sql`DELETE FROM zvd_relations WHERE source_collection IN (${P}, ${C})`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zv_tenant_users WHERE tenant_id IN (${A.id}::uuid, ${B.id}::uuid)`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zv_tenants WHERE id IN (${A.id}::uuid, ${B.id}::uuid)`
      .execute(db)
      .catch(() => {});
  });

  it('every route that serves tenant data has a row, and every row is a route', () => {
    const mounted = new Set(
      (app.routes as Array<{ method: string; path: string }>)
        .filter((r) => r.method !== 'ALL')
        .filter((r) => PREFIXES.some((p) => r.path === p || r.path.startsWith(`${p}/`)))
        .map((r) => `${r.method} ${r.path}`),
    );
    const unlisted = [...mounted].filter((k) => !(k in DOORS)).sort();
    const stale = Object.keys(DOORS)
      .filter((k) => !mounted.has(k))
      .sort();
    expect(
      unlisted,
      'a new door needs a row in DOORS: probe it, point at its test, or say why it is not one',
    ).toEqual([]);
    expect(stale, 'a row for a route that no longer exists').toEqual([]);
  });

  it('every test a row points at exists', async () => {
    for (const c of Object.values(DOORS)) {
      if ('elsewhere' in c) {
        expect(await Bun.file(new URL(`./${c.elsewhere}`, import.meta.url).pathname).exists()).toBe(
          true,
        );
      }
    }
  });

  // ── Data API ────────────────────────────────────────────────────────────

  it('list, search, filter, count and as_of show A nothing of B', async () => {
    probe('GET /api/data/:collection');
    for (const q of [
      '',
      `?search=${MARK}`,
      `?filter[title][_eq]=${MARK}`,
      `?as_of=${encodeURIComponent(new Date().toISOString())}`,
    ]) {
      const res = await app.request(`/api/data/${P}${q}`, { headers: asA() });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toContain(MARK);
      expect(body).not.toContain(ids.pB);
    }
    const counted = await app.request(`/api/data/${P}`, { headers: asA() });
    const page = ((await counted.json()) as { pagination?: { total?: number } }).pagination;
    expect(page?.total).toBe(1);
  });

  it('expand follows no link into B: m2o, o2m and m2m, listed and single', async () => {
    probe('GET /api/data/:collection/:id');
    for (const path of [
      `/api/data/${C}?expand=parent`,
      `/api/data/${C}/${ids.cA2}?expand=parent`,
      `/api/data/${P}?expand=children`,
      `/api/data/${P}/${ids.pA}?expand=children`,
      `/api/data/${P}?expand=tags`,
      `/api/data/${P}/${ids.pA}?expand=tags`,
    ]) {
      const res = await app.request(path, { headers: asA() });
      expect(res.status).toBe(200);
      expect(await leaks(res)).toBe(false);
    }
  });

  it("B's row by id is not found, and cannot be changed or deleted", async () => {
    for (const door of [
      'GET /api/data/:collection/:id',
      'PATCH /api/data/:collection/:id',
      'PUT /api/data/:collection/:id',
      'DELETE /api/data/:collection/:id',
    ]) {
      probe(door);
    }
    expect((await app.request(`/api/data/${P}/${ids.pB}`, { headers: asA() })).status).toBe(404);
    for (const method of ['PATCH', 'PUT']) {
      const res = await app.request(`/api/data/${P}/${ids.pB}`, {
        method,
        headers: asA(json),
        body: JSON.stringify({ title: 'overwritten by A' }),
      });
      expect(res.status).toBe(404);
    }
    expect(
      (await app.request(`/api/data/${P}/${ids.pB}`, { method: 'DELETE', headers: asA() })).status,
    ).toBe(404);
    expect(await rowIn(P, ids.pB)).toEqual({ tenant_id: B.id, title: MARK });
  });

  it('a create lands in the request tenant, whatever the body says', async () => {
    probe('POST /api/data/:collection');
    probe('POST /api/data/:collection/bulk');
    const one = await create(asA, P, { title: `A-one-${TAG}`, tenant_id: B.id });
    expect((await rowIn(P, one))?.tenant_id).toBe(A.id);
    const bulk = await app.request(`/api/data/${P}/bulk`, {
      method: 'POST',
      headers: asA(json),
      body: JSON.stringify({ records: [{ title: `A-bulk-${TAG}`, tenant_id: B.id }] }),
    });
    expect([200, 201]).toContain(bulk.status);
    const landed = await sql<{ tenant_id: string }>`
      SELECT tenant_id::text FROM ${sql.id(`zvd_${P}`)} WHERE title = ${`A-bulk-${TAG}`}`.execute(
      db,
    );
    expect(landed.rows.map((r) => r.tenant_id)).toEqual([A.id]);
  });

  it("bulk update and delete do not reach B's rows", async () => {
    probe('PATCH /api/data/:collection/bulk');
    probe('DELETE /api/data/:collection/bulk');
    await app.request(`/api/data/${P}/bulk`, {
      method: 'PATCH',
      headers: asA(json),
      body: JSON.stringify({ records: [{ id: ids.pB, title: 'bulk-overwritten' }] }),
    });
    await app.request(`/api/data/${P}/bulk`, {
      method: 'DELETE',
      headers: asA(json),
      body: JSON.stringify({ ids: [ids.pB] }),
    });
    expect(await rowIn(P, ids.pB)).toEqual({ tenant_id: B.id, title: MARK });
  });

  it('an API key of A reads A only, and is refused in B', async () => {
    const mine = await app.request(`/api/data/${P}`, {
      headers: { 'X-API-Key': KEY, 'x-tenant-slug': A.slug },
    });
    expect(mine.status).toBe(200);
    expect(await leaks(mine)).toBe(false);
    const theirs = await app.request(`/api/data/${P}`, {
      headers: { 'X-API-Key': KEY, 'x-tenant-slug': B.slug },
    });
    expect([401, 403]).toContain(theirs.status);
  });

  // ── Offline sync ────────────────────────────────────────────────────────

  it('sync pull brings A nothing of B, and sync push does not change B', async () => {
    probe('POST /api/sync/pull');
    probe('POST /api/sync/push');
    const pull = await app.request('/api/sync/pull', {
      method: 'POST',
      headers: asA(json),
      body: JSON.stringify({ collections: [P, C, T] }),
    });
    expect(pull.status).toBe(200);
    expect(await leaks(pull)).toBe(false);
    await app.request('/api/sync/push', {
      method: 'POST',
      headers: asA(json),
      body: JSON.stringify({
        operations: [
          {
            id: crypto.randomUUID(),
            collection: P,
            operation: 'update',
            record_id: ids.pB,
            data: { title: 'pushed by A' },
            timestamp: Date.now(),
          },
        ],
      }),
    });
    expect(await rowIn(P, ids.pB)).toEqual({ tenant_id: B.id, title: MARK });
  });

  // ── Realtime ────────────────────────────────────────────────────────────

  it('a write in B reaches no socket and no stream in A; a write in A does', async () => {
    probe('GET /api/ws');
    probe('GET /api/realtime/stream');
    const data = await wsUpgradeData(app, asA());
    expect(data).toBeDefined();
    const id = `doors_ws_${TAG}`;
    wsProbes.push(id);
    const sent: string[] = [];
    const ws = { data: { ...data, id }, send: (p: string) => sent.push(p), close: () => {} };
    websocketHandler.open(ws as never);
    await websocketHandler.message(
      ws as never,
      JSON.stringify({ type: 'subscribe', collections: [P] }),
    );
    expect(sent.join('\n')).toContain('"type":"subscribed"');

    const stream = await app.request(`/api/realtime/stream?collection=${P}`, { headers: asA() });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    const streamed: string[] = [];
    const decoder = new TextDecoder();
    const reading = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        streamed.push(decoder.decode(value));
      }
    })();

    const control = `A-live-${TAG}`;
    await create(asB, P, { title: `${MARK}-live` });
    await create(asA, P, { title: control });
    for (
      let i = 0;
      i < 100 && !(sent.join('').includes(control) && streamed.join('').includes(control));
      i++
    ) {
      await Bun.sleep(30);
    }
    await reader.cancel().catch(() => {});
    await reading.catch(() => {});
    expect(sent.join('\n')).toContain(control);
    expect(streamed.join('')).toContain(control);
    expect(sent.join('\n')).not.toContain(MARK);
    expect(streamed.join('')).not.toContain(MARK);
  }, 30_000);

  // ── Revisions and comments ──────────────────────────────────────────────

  it("B's revision is not found by A, and cannot be reverted", async () => {
    probe('GET /api/revisions/:id');
    probe('POST /api/revisions/:id/revert');
    const rev = await sql<{ id: string }>`
      SELECT id::text FROM zv_revisions WHERE collection = ${P} AND record_id = ${ids.pB} LIMIT 1`.execute(
      db,
    );
    const revId = rev.rows[0]?.id;
    expect(revId).toBeDefined();
    const got = await app.request(`/api/revisions/${revId}`, { headers: asA() });
    expect([403, 404]).toContain(got.status);
    expect(await leaks(got)).toBe(false);
    await app.request(`/api/revisions/${revId}/revert`, { method: 'POST', headers: asA() });
    expect(await rowIn(P, ids.pB)).toEqual({ tenant_id: B.id, title: MARK });
  });

  it("B's comments are not read, written into or deleted from A", async () => {
    for (const door of [
      'GET /api/revisions/record/:collection/:recordId/comments',
      'POST /api/revisions/record/:collection/:recordId/comments',
      'DELETE /api/revisions/record/comments/:commentId',
    ]) {
      probe(door);
    }
    const bPost = await app.request(`/api/revisions/record/${P}/${ids.pB}/comments`, {
      method: 'POST',
      headers: asB(json),
      body: JSON.stringify({ comment: MARK }),
    });
    expect([200, 201]).toContain(bPost.status);
    const comment = await sql<{ id: string }>`
      SELECT id::text FROM zv_record_comments WHERE record_id = ${ids.pB} LIMIT 1`.execute(db);
    const commentId = comment.rows[0]!.id;

    const read = await app.request(`/api/revisions/record/${P}/${ids.pB}/comments`, {
      headers: asA(),
    });
    expect(await leaks(read)).toBe(false);

    const aText = `A-wrote-${TAG}`;
    await app.request(`/api/revisions/record/${P}/${ids.pB}/comments`, {
      method: 'POST',
      headers: asA(json),
      body: JSON.stringify({ comment: aText }),
    });
    const seenByB = await app.request(`/api/revisions/record/${P}/${ids.pB}/comments`, {
      headers: asB(),
    });
    expect(await seenByB.text()).not.toContain(aText);

    await app.request(`/api/revisions/record/comments/${commentId}`, {
      method: 'DELETE',
      headers: asA(),
    });
    const kept = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zv_record_comments WHERE id = ${commentId}::uuid`.execute(db);
    expect(kept.rows[0]!.n).toBe(1);
  });

  // ── Storage ─────────────────────────────────────────────────────────────

  it("B's file gets no signed URL and no transform in A; B's folder is not listed", async () => {
    for (const door of [
      'GET /api/storage/:id/signed-url',
      'GET /api/storage/:id/transform',
      'GET /api/storage/folders',
      'POST /api/storage/folders',
    ]) {
      probe(door);
    }
    const file = await sql<{ id: string }>`
      INSERT INTO zv_media_files (tenant_id, filename, original_name, mimetype, storage_path, visibility)
      VALUES (${B.id}::uuid, ${`doors-file-${TAG}`}, ${MARK}, 'image/png', ${`doors/${TAG}.png`}, 'tenant')
      RETURNING id::text`.execute(db);
    const fileId = file.rows[0]!.id;
    for (const path of [
      `/api/storage/${fileId}/signed-url`,
      `/api/storage/${fileId}/transform?w=10`,
    ]) {
      const res = await app.request(path, { headers: asA() });
      expect(res.status).toBe(404);
      expect(await leaks(res)).toBe(false);
    }

    const folder = await app.request('/api/storage/folders', {
      method: 'POST',
      headers: asB(json),
      body: JSON.stringify({ name: `doors-folder-${TAG}` }),
    });
    expect([200, 201]).toContain(folder.status);
    const listed = await app.request('/api/storage/folders', { headers: asA() });
    expect(listed.status).toBe(200);
    expect(await listed.text()).not.toContain(`doors-folder-${TAG}`);
    const landed = await sql<{ tenant_id: string }>`
      SELECT tenant_id::text FROM zv_media_folders WHERE name = ${`doors-folder-${TAG}`}`.execute(
      db,
    );
    expect(landed.rows.map((r) => r.tenant_id)).toEqual([B.id]);
  });

  it("a saved query lands in A; B's cannot be changed, deleted or run from A; execute reads no B row", async () => {
    for (const door of [
      'POST /api/saved-queries',
      'PUT /api/saved-queries/:id',
      'DELETE /api/saved-queries/:id',
      'POST /api/saved-queries/:id/run',
      'POST /api/saved-queries/execute',
    ]) {
      probe(door);
    }
    const save = (who: () => Record<string, string>, name: string) =>
      app.request('/api/saved-queries', {
        method: 'POST',
        headers: { ...who(), ...json },
        body: JSON.stringify({ name, collection: P, config: {}, is_shared: true }),
      });
    const id = async (res: Response) => {
      expect(res.status).toBe(201);
      const out = (await res.json()) as { query?: { id: string }; id?: string };
      return (out.query?.id ?? out.id)!;
    };
    const tenantOf = async (qid: string) =>
      (
        await sql<{ tenant_id: string; name: string }>`
          SELECT tenant_id::text, name FROM zv_saved_queries WHERE id = ${qid}::uuid`.execute(db)
      ).rows[0];
    const qA = await id(await save(asA, `doors-qa-${TAG}`));
    const qB = await id(await save(asB, `doors-qb-${TAG}`));
    expect((await tenantOf(qA))?.tenant_id).toBe(A.id);

    const put = await app.request(`/api/saved-queries/${qB}`, {
      method: 'PUT',
      headers: asA(json),
      body: JSON.stringify({ name: 'overwritten by A' }),
    });
    expect(put.status).toBe(404);
    const run = await app.request(`/api/saved-queries/${qB}/run`, {
      method: 'POST',
      headers: asA(json),
      body: '{}',
    });
    expect(run.status).toBe(404);
    expect(await leaks(run)).toBe(false);
    const del = await app.request(`/api/saved-queries/${qB}`, { method: 'DELETE', headers: asA() });
    expect(del.status).toBe(404);
    expect(await tenantOf(qB)).toEqual({ tenant_id: B.id, name: `doors-qb-${TAG}` });

    // A's own query over P runs, and shows none of B's rows.
    const mine = await app.request(`/api/saved-queries/${qA}/run`, {
      method: 'POST',
      headers: asA(json),
      body: '{}',
    });
    expect(mine.status).toBe(200);
    expect(await leaks(mine)).toBe(false);
    const exec = await app.request('/api/saved-queries/execute', {
      method: 'POST',
      headers: asA(json),
      body: JSON.stringify({ collection: P, config: {} }),
    });
    expect(exec.status).toBe(200);
    const body = await exec.text();
    expect(body).toContain(`A-${TAG}`);
    expect(body).not.toContain(MARK);
  });

  it('an RPC call from A runs under A, and reads none of B', async () => {
    probe('POST /api/rpc/:fn');
    // SECURITY INVOKER (the default): the function reads as its caller.
    const fn = `doors_fn_${TAG}`;
    await sql
      .raw(
        `CREATE FUNCTION ${fn}() RETURNS SETOF zvd_${P} LANGUAGE sql STABLE AS 'SELECT * FROM zvd_${P}'`,
      )
      .execute(db);
    await sql`INSERT INTO zvd_rpc_functions (function_name, required_role, is_enabled)
              VALUES (${fn}, 'member', true)`.execute(db);
    const res = await app.request(`/api/rpc/${fn}`, { method: 'POST', headers: asA(json) });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`A-${TAG}`);
    expect(body).not.toContain(MARK);
  });

  it('every row marked `here` was probed above', () => {
    const marked = Object.entries(DOORS)
      .filter(([, c]) => 'here' in c)
      .map(([k]) => k)
      .sort();
    expect([...probed].sort()).toEqual(marked);
  });
});
