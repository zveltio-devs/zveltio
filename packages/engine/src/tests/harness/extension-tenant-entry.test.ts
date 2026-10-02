/**
 * `ctx.internals.withTenantIsolation(tenantId, fn)` enters only the tenant the
 * work already runs as — any other firm needs `tenant:enter` (or `db:admin`,
 * which implies it).
 *
 * It was ungated and took the tenant as a plain argument: an extension with no
 * capability at all, handling a request in firm A, opened a transaction as firm
 * B and read B's rows. That is more than `ctx.adminDb` grants, and `adminDb`
 * needs `db:admin`. Measured here before the fix: the zero-capability route
 * below answered with B's row.
 *
 * Driven through the engine's own loader behind the real `/ext/*` chain
 * (prefetch, tenant transaction, auth gate), as `index.ts` mounts it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { finalizeExtensionLoad } from '../../lib/extensions/register.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import type { ExtensionContext, ExtensionInternals } from '../../lib/extensions/internals.js';
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import { getAuth } from '../../lib/auth.js';
import { runAsTenantWithoutTransaction } from '../../lib/tenancy/index.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import { createMemberSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const ROOT = '00000000-0000-0000-0000-000000000001';
const OTHER = crypto.randomUUID();
const SLUG = `ten-${OTHER.slice(0, 8)}`;
const STAMP = `tenentry_${Date.now()}`;
const NOCAP = `tenentry-nocap-${Date.now()}`;
const ADMIN = `tenentry-admin-${Date.now()}`;
const ENTER = `tenentry-enter-${Date.now()}`;

d('ctx.internals.withTenantIsolation enters only the running tenant without tenant:enter', () => {
  let db: Database;
  let app: Hono;
  let member: { cookie: string; userId: string };
  const bags: Record<string, ExtensionInternals> = {};
  const adminDbs: Record<string, Database> = {};
  let later: Promise<unknown> = Promise.resolve();

  /** Rows of the seeded table the entered transaction can see, by firm. */
  const peek = (internals: ExtensionInternals, tenant: string) =>
    internals.withTenantIsolation(tenant, async (trx) =>
      (
        await sql<{ tenant_id: string }>`
          SELECT tenant_id FROM zv_dashboards WHERE name = ${STAMP}`.execute(trx)
      ).rows.map((r) => r.tenant_id),
    );
  const outcome = (p: Promise<string[]>) =>
    p.then(
      (seen) => ({ seen }),
      (err: Error) => ({ refused: err.message.includes('tenant:enter') }),
    );

  async function load(name: string, permissions: string[]): Promise<void> {
    await sql`DELETE FROM zv_extension_registry WHERE name = ${name}`.execute(db);
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
      VALUES (${name}, ${name}, NULL, true, true)`.execute(db);
    const ctx = { db, internals: buildExtensionInternals() } as unknown as ExtensionContext;
    const loader = {
      loaded: new Map(),
      modules: new Map(),
      lastLoadError: new Map(),
      extDirs: new Map(),
      forgetExtensionMessages: () => {},
      ctx,
    } as unknown as ExtensionLoader;
    const ext: ZveltioExtension = {
      name,
      category: 'custom',
      mountStrategy: 'subapp',
      async register(sub, ectx) {
        const internals = ectx.internals as unknown as ExtensionInternals;
        bags[name] = internals;
        adminDbs[name] = ectx.adminDb as unknown as Database;
        sub.get('/peek', async (c) => c.json(await outcome(peek(internals, c.req.query('t')!))));
        // Fire-and-forget past the response, as `data/export` and `data/import` do.
        sub.get('/later', (c) => {
          const t = c.req.query('t')!;
          later = Bun.sleep(50).then(() => outcome(peek(internals, t)));
          return c.json({ queued: true });
        });
      },
    };
    await finalizeExtensionLoad(
      loader,
      ext,
      name,
      `/tmp/${name}`,
      app,
      ctx,
      { name, version: '1.0.0', category: 'custom', permissions } as never,
      // The probe reads zv_dashboards with raw SQL; inside the callback that is
      // checked against the extension's tables, so the probe holds a grant.
      new Set(['zv_dashboards']),
    );
  }

  const get = async (ext: string, tenant: string) =>
    (
      await app.request(`/ext/${ext}/peek?t=${tenant}`, { headers: { cookie: member.cookie } })
    ).json();

  beforeAll(async () => {
    let engine: Hono;
    ({ app: engine, db } = await getTestApp());
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY = '1';
    member = await createMemberSession(engine, db);
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${OTHER}::uuid, ${SLUG}, ${SLUG}, 'active')`.execute(db);
    for (const tenant of [ROOT, OTHER]) {
      await sql`INSERT INTO zv_dashboards (name, is_public, tenant_id)
                VALUES (${STAMP}, true, ${tenant}::uuid)`.execute(db);
    }
    app = new Hono();
    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));
    await load(NOCAP, []);
    // The legacy label grants nothing; `data/export` declares only this.
    await load(ADMIN, ['database', 'db:admin']);
    await load(ENTER, ['tenant:enter']);
    invalidateActivationCache();
  }, 60_000);

  afterAll(async () => {
    invalidateActivationCache();
    if (!db) return;
    await sql`DELETE FROM zv_extension_registry WHERE name IN (${NOCAP}, ${ADMIN}, ${ENTER})`.execute(
      db,
    );
    await sql`DELETE FROM zv_dashboards WHERE name = ${STAMP}`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER}::uuid`.execute(db);
  });

  it('refuses another firm from inside a request, with no capability', async () => {
    expect(await get(NOCAP, OTHER)).toEqual({ refused: true });
  });

  it('enters the request’s own firm with no capability', async () => {
    expect(await get(NOCAP, ROOT)).toEqual({ seen: [ROOT] });
  });

  it('a job started by the request keeps its firm after the response', async () => {
    const ask = (t: string) =>
      app.request(`/ext/${NOCAP}/later?t=${t}`, { headers: { cookie: member.cookie } });
    expect((await ask(ROOT)).status).toBe(200);
    expect(await later).toEqual({ seen: [ROOT] });
    expect((await ask(OTHER)).status).toBe(200);
    expect(await later).toEqual({ refused: true });
  });

  it('refuses outside any request or job, with no capability', async () => {
    // Load time, a timer, a tenant-less route: no tenant to inherit, so the
    // tenant is only whatever the extension wrote.
    expect(await outcome(peek(bags[NOCAP]!, OTHER))).toEqual({ refused: true });
    expect(await outcome(peek(bags[NOCAP]!, ROOT))).toEqual({ refused: true });
  });

  it('enters the job’s firm, as an AI task does', async () => {
    const r = await runAsTenantWithoutTransaction(OTHER, () => outcome(peek(bags[NOCAP]!, OTHER)));
    expect(r).toEqual({ seen: [OTHER] });
    const x = await runAsTenantWithoutTransaction(OTHER, () => outcome(peek(bags[NOCAP]!, ROOT)));
    expect(x).toEqual({ refused: true });
  });

  it('db:admin may enter any firm, in a request or out of one', async () => {
    expect(await get(ADMIN, OTHER)).toEqual({ seen: [OTHER] });
    expect(await outcome(peek(bags[ADMIN]!, OTHER))).toEqual({ seen: [OTHER] });
  });

  it('hands the callback the same table guard as ctx.db, not a bare transaction', async () => {
    // The transaction was passed through unwrapped: an extension with no grant
    // reached every engine table through it — `zv_api_keys` here, but equally
    // `user` or `account` — although `ctx.db` refuses them.
    // `db:admin` gets the same guard on `ctx.adminDb`, so it gets it here too.
    for (const ext of [NOCAP, ADMIN, ENTER]) {
      const r = await runAsTenantWithoutTransaction(ROOT, () =>
        bags[ext]!.withTenantIsolation(ROOT, async (trx) => {
          trx.selectFrom('zv_api_keys' as never);
          return 'reached';
        }).catch((err: Error) => err.message),
      );
      expect(r).toContain('attempted to access table "zv_api_keys"');
    }
  });

  it('tenant:enter may enter any firm, and grants no adminDb', async () => {
    expect(await get(ENTER, OTHER)).toEqual({ seen: [OTHER] });
    expect(await outcome(peek(bags[ENTER]!, OTHER))).toEqual({ seen: [OTHER] });
    expect(() => adminDbs[ENTER]!.selectFrom('zv_dashboards')).toThrow('db:admin');
  });
});
