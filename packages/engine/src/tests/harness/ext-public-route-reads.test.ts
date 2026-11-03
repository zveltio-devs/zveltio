/**
 * ADR 0020: a public route reads as the tenant's `public` role.
 *
 * A `publicRoutes` handler has no gate principal, so `ctx.internals.listRecords`
 * and `readRecord` threw there and content/pages could not build its sitemap
 * server-side. Inside a request the `/ext/*` gate admitted as one of the calling
 * extension's public routes they now read as the anonymous visitor of ADR 0017:
 * the `public` role's Casbin grants, collection policies, row rules and column
 * permissions, deny by default. Reads only; anywhere else they still throw.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { ExtensionContext as SdkContext, ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { finalizeExtensionLoad } from '../../lib/extensions/register.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { ManifestSchema } from '../../lib/extensions/manifest-schema.js';
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import { DDLManager } from '../../lib/data/index.js';
import { getAuth } from '../../lib/auth.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import {
  getCurrentTenantTrx,
  getEnforcer,
  invalidateAllPermissionCaches,
  invalidateRlsCache,
} from '../../lib/tenancy/index.js';
import { clearLocalRateLimitCache } from '../../middleware/rate-limit.js';
import {
  asTenant,
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';
import { toJsonb } from '../../lib/jsonb.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT_A = '00000000-0000-0000-0000-000000000001';
const STAMP = String(Date.now()).slice(-7);
const COLL = `prr_${STAMP}`;
const EXT = `prr-ext-${STAMP}`;
const OTHER = `prr-other-${STAMP}`;
const B = { id: crypto.randomUUID(), slug: `prr-b-${STAMP}` };

type Rec = Record<string, unknown>;
type Answer = { status: number; body: Rec };

d('a public route reads as the public role (ADR 0020)', () => {
  let engine: Hono;
  let db: Database;
  let app: Hono;
  let god = '';
  /** A member granted nothing on the collection. */
  let member = '';
  let published = '';
  let draft = '';
  let ruleId = '';
  let kept: Context | undefined;
  let late: Promise<Answer> | undefined;
  /** A read the handler did not await, and when it settled. */
  let inflight: Promise<Answer> | undefined;
  let inflightSettled = false;
  let otherInternals: SdkContext['internals'];

  function loader(ctx: ExtensionContext): ExtensionLoader {
    return {
      loaded: new Map(),
      modules: new Map(),
      lastLoadError: new Map(),
      extDirs: new Map(),
      forgetExtensionMessages: () => {},
      ctx,
    } as unknown as ExtensionLoader;
  }

  async function load(ext: ZveltioExtension, manifest: Record<string, unknown>): Promise<void> {
    const parsed = ManifestSchema.parse({ name: ext.name, ...manifest });
    await sql`DELETE FROM zv_extension_registry WHERE name = ${ext.name}`.execute(db);
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled, manifest)
      VALUES (${ext.name}, ${ext.name}, NULL, true, true, ${toJsonb(parsed)})
    `.execute(db);
    const ctx = { db, internals: buildExtensionInternals() } as unknown as ExtensionContext;
    await finalizeExtensionLoad(
      loader(ctx),
      ext,
      ext.name,
      `/tmp/${ext.name}`,
      app,
      ctx,
      parsed as never,
      new Set(),
    );
  }

  /** The read's answer as the handler's, or the refusal's message (418). */
  const answering = (read: () => Promise<Answer>) => async (c: Context) => {
    try {
      const a = await read();
      return c.json(a.body, a.status as never);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 418);
    }
  };

  const routes = (ctx: SdkContext) => (r: Hono) => {
    const i = ctx.internals!;
    r.get('/pub/list', (c) => answering(() => i.listRecords(c, COLL))(c));
    r.get('/pub/one/:id', (c) => answering(() => i.readRecord(c, COLL, c.req.param('id')))(c));
    r.get('/priv/list', (c) => answering(() => i.listRecords(c, COLL))(c));
    r.post('/pub/write', (c) =>
      answering(() => i.createRecord(c, COLL, { title: 'from-public-route' }))(c),
    );
    r.get('/pub/keep', (c) => {
      kept = c;
      return c.json({});
    });
    r.get('/pub/stale', (c) => answering(() => i.listRecords(kept!, COLL))(c));
    r.get('/pub/late', (c) => {
      late = Bun.sleep(300).then(() => i.listRecords(c, COLL));
      late.catch(() => {});
      return c.json({});
    });
    r.get('/pub/inflight', (c) => {
      inflightSettled = false;
      inflight = i.listRecords(c, COLL).finally(() => {
        inflightSettled = true;
      });
      inflight.catch(() => {});
      return c.json({});
    });
    // Two reads at once, then what the request's transaction publishes after.
    r.get('/pub/both', async (c) => {
      const [a, b] = await Promise.all([i.listRecords(c, COLL), i.listRecords(c, COLL)]);
      const trx = getCurrentTenantTrx()!;
      const { rows } = await sql<{ u: string; bypass: string }>`
        SELECT current_setting('zveltio.user_id', true) AS u,
               current_setting('zveltio.rls_bypass', true) AS bypass`.execute(trx);
      return c.json({ a: a.body, b: b.body, after: rows[0] });
    });
    // Several reads, uncaught: the rate limit's refusal is the handler's throw.
    r.get('/pub/many', async (c) => {
      for (let n = 0; n < 3; n++) {
        const a = await i.listRecords(c, COLL);
        if (a.status !== 200) return c.json(a.body, 500);
      }
      return c.json({});
    });
    // Another extension's member, handed this extension's public request.
    r.get('/pub/foreign', (c) => answering(() => otherInternals!.listRecords(c, COLL))(c));
  };

  const get = (path: string, cookie?: string) =>
    app.request(`/ext/${EXT}${path}`, { headers: cookie ? { cookie } : {} });
  const json = async (res: Response) => (await res.json()) as Rec;
  const titles = async (res: Response) =>
    ((await json(res)).records as Rec[]).map((r) => r.title).sort();
  const grant = async (on: boolean, action = 'read') => {
    const e = await getEnforcer();
    if (on) await e.addPolicy('public', TENANT_A, COLL, action);
    else await e.removePolicy('public', TENANT_A, COLL, action);
    await invalidateAllPermissionCaches();
  };

  beforeAll(async () => {
    ({ app: engine, db } = await getTestApp());
    god = await createGodSession(engine, db);
    member = (await createMemberSession(engine, db, {})).cookie;
    const text = (name: string) =>
      ({ name, type: 'text', required: false, unique: false, indexed: false }) as never;
    await DDLManager.createCollection(db, {
      name: COLL,
      fields: [text('title'), text('status'), text('secret')],
    } as never);
    const create = async (body: Rec) => {
      const res = await engine.request(`/api/data/${COLL}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: god },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };
    published = await create({ title: 'pub', status: 'published', secret: 's1' });
    draft = await create({ title: 'draft', status: 'draft', secret: 's2' });
    // Another tenant's published row: no visitor of tenant A reads it, god or not.
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${B.id}::uuid, ${B.slug}, 'prrb', 'active')`.execute(db);
    await asTenant(db, B.id, (trx) =>
      sql`INSERT INTO ${sql.table(`zvd_${COLL}`)} (title, status, tenant_id)
          VALUES ('other-firm', 'published', ${B.id}::uuid)`.execute(trx),
    );

    app = new Hono();
    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));
    await load(
      {
        name: EXT,
        category: 'custom',
        mountStrategy: 'subapp',
        async register(r, ctx) {
          routes(ctx as SdkContext)(r as Hono);
        },
      },
      { permissions: ['data:write'], publicRoutes: ['/pub/*'] },
    );
    await load(
      {
        name: OTHER,
        category: 'custom',
        mountStrategy: 'subapp',
        async register(_r, ctx) {
          otherInternals = (ctx as SdkContext).internals;
        },
      },
      { publicRoutes: ['/pub/*'] },
    );
    invalidateActivationCache();
  }, 60_000);

  afterAll(async () => {
    invalidateActivationCache();
    if (!db) return;
    await grant(false).catch(() => {});
    await grant(false, 'create').catch(() => {});
    if (ruleId) {
      await sql`DELETE FROM zvd_rls_policies WHERE id = ${ruleId}::uuid`
        .execute(db)
        .catch(() => {});
      await invalidateRlsCache(COLL).catch(() => {});
    }
    await sql`DELETE FROM zvd_column_permissions WHERE collection_name = ${COLL}`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zv_extension_registry WHERE name IN (${EXT}, ${OTHER})`.execute(db);
    await asTenant(db, B.id, (trx) =>
      sql`DELETE FROM ${sql.table(`zvd_${COLL}`)} WHERE tenant_id = ${B.id}::uuid`.execute(trx),
    ).catch(() => {});
    await dropTestCollection(db, COLL).catch(() => {});
    await sql`DELETE FROM zv_tenants WHERE id = ${B.id}::uuid`.execute(db).catch(() => {});
    await sql`DELETE FROM zv_rate_limit_configs WHERE key_prefix = 'anon-read'`
      .execute(db)
      .catch(() => {});
    clearLocalRateLimitCache('anon-read');
  });

  it('with no grant, public reads nothing: 403 on both members, no rows', async () => {
    for (const path of ['/pub/list', `/pub/one/${published}`]) {
      const res = await get(path);
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).not.toContain('s1');
    }
  });

  it('granted read: rows, under the public row rule and column permission', async () => {
    await grant(true);
    const rule = await engine.request('/api/admin/rls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({
        collection: COLL,
        role: 'public',
        filter_field: 'status',
        filter_op: 'eq',
        filter_value_source: 'static:published',
      }),
    });
    expect(rule.status).toBe(201);
    ruleId = ((await rule.json()) as { policy: { id: string } }).policy.id;
    const col = await engine.request('/api/admin/column-permissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({
        collection_name: COLL,
        column_name: 'secret',
        role: 'public',
        can_read: false,
        can_write: false,
      }),
    });
    expect([200, 201]).toContain(col.status);

    const list = await get('/pub/list');
    expect(list.status).toBe(200);
    const records = (await json(list)).records as Rec[];
    expect(records.map((r) => r.title)).toEqual(['pub']);
    expect(records[0]!.secret).toBeUndefined();
    const one = await get(`/pub/one/${published}`);
    expect(one.status).toBe(200);
    expect((await json(one)).secret).toBeUndefined();
    expect((await get(`/pub/one/${draft}`)).status).toBe(404);
  });

  it('a signed-in visitor of a public route reads as public, not as themselves', async () => {
    // The request transaction publishes the visitor — god, or a member the
    // database refuses the collection — and the read is still the public role's.
    for (const cookie of [god, member]) {
      const res = await get('/pub/list', cookie);
      expect(res.status).toBe(200);
      const records = (await json(res)).records as Rec[];
      expect(records.map((r) => r.title)).toEqual(['pub']);
      expect(records[0]!.secret).toBeUndefined();
      expect((await get(`/pub/one/${published}`, cookie)).status).toBe(200);
      expect((await get(`/pub/one/${draft}`, cookie)).status).toBe(404);
    }
    // The member's own session route is refused, as the member is.
    expect((await get('/priv/list', member)).status).toBe(403);
  });

  it('a session route still reads as its principal', async () => {
    const res = await get('/priv/list', god);
    expect(res.status).toBe(200);
    // God's read bypass is instance-wide, so every firm's rows.
    expect(await titles(res)).toEqual(['draft', 'other-firm', 'pub']);
    // Anonymous, the session route is the gate's 401, as before.
    expect((await get('/priv/list')).status).toBe(401);
  });

  it('a public route cannot write, even with public granted create', async () => {
    await grant(true, 'create');
    try {
      const res = await app.request(`/ext/${EXT}/pub/write`, { method: 'POST' });
      expect(res.status).toBe(418);
      expect((await json(res)).error).toContain('createRecord');
    } finally {
      await grant(false, 'create');
    }
    const all = await engine.request(`/api/data/${COLL}`, { headers: { cookie: god } });
    expect(await titles(all)).toEqual(['draft', 'other-firm', 'pub']);
  });

  it('two reads at once both read as public; the visitor is published again after', async () => {
    const res = await get('/pub/both', god);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { a: Rec; b: Rec; after: { u: string; bypass: string } };
    for (const side of [body.a, body.b]) {
      expect((side.records as Rec[]).map((r) => r.title)).toEqual(['pub']);
    }
    // The request's transaction is god's again: their id and their read bypass.
    expect(body.after.u).not.toBe('');
    expect(body.after.bypass).toBe('on');
  });

  it('a read the handler did not await holds the transaction until it is done', async () => {
    const res = await get('/pub/inflight', god);
    expect(res.status).toBe(200);
    // Settled before the answer: the request's COMMIT waited for it, so none of
    // its statements ran on a finished transaction.
    expect(inflightSettled).toBe(true);
    const a = await inflight!;
    expect(a.status).toBe(200);
    expect((a.body.records as Rec[]).map((r) => r.title)).toEqual(['pub']);
  });

  it('charges the anonymous read rate limit once per request, and its refusal throws', async () => {
    await sql`INSERT INTO zv_rate_limit_configs (key_prefix, window_ms, max_requests)
              VALUES ('anon-read', 60000, 2)
              ON CONFLICT (key_prefix) DO UPDATE SET window_ms = 60000, max_requests = 2`.execute(
      db,
    );
    clearLocalRateLimitCache('anon-read');
    // The limiter stands down under NODE_ENV=test; the address is the bucket.
    const env = { NODE_ENV: process.env.NODE_ENV, TRUSTED_PROXY: process.env.TRUSTED_PROXY };
    process.env.NODE_ENV = 'production';
    process.env.TRUSTED_PROXY = 'true';
    const ip = `198.51.100.${(Number(STAMP) % 250) + 1}`;
    try {
      const many = () => app.request(`/ext/${EXT}/pub/many`, { headers: { 'x-real-ip': ip } });
      // Three reads each, one unit each: the budget of two admits two requests.
      expect((await many()).status).toBe(200);
      expect((await many()).status).toBe(200);
      const refused = await many();
      expect(refused.status).toBe(429);
      expect(refused.headers.get('retry-after')).toBeTruthy();
    } finally {
      process.env.NODE_ENV = env.NODE_ENV;
      if (env.TRUSTED_PROXY === undefined) delete process.env.TRUSTED_PROXY;
      else process.env.TRUSTED_PROXY = env.TRUSTED_PROXY;
      await sql`DELETE FROM zv_rate_limit_configs WHERE key_prefix = 'anon-read'`.execute(db);
      clearLocalRateLimitCache('anon-read');
    }
  });

  it('refuses a kept context, work left running, and another extension', async () => {
    expect((await get('/pub/keep')).status).toBe(200);
    const stale = await get('/pub/stale');
    expect(stale.status).toBe(418);
    expect((await json(stale)).error).toContain('listRecords');

    expect((await get('/pub/late')).status).toBe(200);
    await expect(late!).rejects.toThrow('listRecords');

    const foreign = await get('/pub/foreign');
    expect(foreign.status).toBe(418);
    expect((await json(foreign)).error).toContain('listRecords');
  });
});
