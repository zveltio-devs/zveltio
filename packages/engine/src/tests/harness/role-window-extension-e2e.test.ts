/**
 * The role-window escalation, end to end through a real extension route.
 *
 * `asEngineRole` steps the request transaction out of its role (`zveltio_rls`)
 * into the engine's login — a superuser here — for a statement or two. Before
 * the sequencer (`db/trx-sequencer.ts`) ran each window alone on its
 * transaction, anything a `Promise.all` sibling sent in between ran as that
 * login, past every row policy. `trx-concurrency.test.ts` pins the primitive;
 * this drives it the way an extension can: one route on the engine's own
 * `/ext/*` chain racing an engine-window helper reachable from `ctx`
 * (`ctx.internals.liftOwnBan(ctx.db, …)` opens `asEngineRole` on the request's
 * transaction) against its own tenant-scoped `ctx.db` read, which has no tenant
 * predicate and so relies on RLS alone, and an engine read
 * (`ctx.internals.listRecords`).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { finalizeExtensionLoad } from '../../lib/extensions/register.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import { ensureExtensionDbRole } from '../../lib/extensions/ext-db-role.js';
import { DDLManager } from '../../lib/data/index.js';
import { withTenantIsolation } from '../../lib/tenancy/index.js';
import { getAuth } from '../../lib/auth.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const C = `rwe_${STAMP}`;
const EXT = `rwe-racer-${STAMP}`;
const OTHER = crypto.randomUUID();
const ROUNDS = 10;
const HOPS = 24;

interface Round {
  role: string;
  tenants: string[];
  labels: string[];
}

d('an extension racing an engine window reads only its tenant, as its own role', () => {
  let engine: Hono;
  let db: Database;
  let app: Hono;
  let member: { cookie: string; userId: string };
  let own = '';

  const call = async (path: string): Promise<Response> =>
    app.request(`/ext/${EXT}${path}`, { method: 'POST', headers: { cookie: member.cookie } });

  beforeAll(async () => {
    ({ app: engine, db } = await getTestApp());
    _setInlineForTests(true);
    expect(await ensureExtensionDbRole(db)).toBe(true);
    await createGodSession(engine, db);
    await DDLManager.createCollection(db, {
      name: C,
      fields: [{ name: 'label', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    for (let i = 0; i < 100; i++) {
      const seen = await sql<{ t: string | null }>`SELECT to_regclass(${`zvd_${C}`}) AS t`.execute(
        db,
      );
      if (seen.rows[0]?.t) break;
      await Bun.sleep(100);
    }
    member = await createMemberSession(engine, db, {
      grants: [{ collection: C, actions: ['read'] }],
    });

    app = new Hono();
    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));

    const ext: ZveltioExtension = {
      name: EXT,
      category: 'custom',
      mountStrategy: 'subapp',
      async register(sub, ctx) {
        sub.post('/tenant', (c) => c.json({ id: (c.get('tenant') as { id: string }).id }));
        sub.post('/race', async (c) => {
          // The extension's own read: tenant-scoped by RLS alone, no predicate.
          const read = async (): Promise<Omit<Round, 'labels'>> => {
            const r = await sql<{ role: string; tenants: string[] | null }>`
              SELECT current_user AS role,
                     (SELECT array_agg(DISTINCT tenant_id::text ORDER BY tenant_id::text)
                        FROM ${sql.table(`zvd_${C}`)}) AS tenants`.execute(ctx.db as never);
            return { role: r.rows[0]!.role, tenants: r.rows[0]!.tenants ?? [] };
          };
          const list = async () => {
            const res = await ctx.internals.listRecords(c, C, { limit: 100 });
            if (res.status !== 200) throw new Error(`listRecords ${res.status}`);
            return (res.body.records as Array<{ label: string }>).map((x) => x.label).sort();
          };
          // Opens `asEngineRole` on this request's transaction (a no-op UPDATE).
          // Started `hops` microtasks late, so it opens at a different point of
          // the siblings' statements in each request.
          const hops = Number(c.req.query('hops') ?? 0);
          const window = async () => {
            for (let h = 0; h < hops; h++) await Promise.resolve();
            return ctx.internals.liftOwnBan(ctx.db, crypto.randomUUID());
          };
          const rounds: Round[] = [];
          const failed: string[] = [];
          for (let i = 0; i < ROUNDS && failed.length === 0; i++) {
            // Both orders: who queues first decides what lands inside whose window.
            const [a, b, labels] = await Promise.allSettled(
              i % 2 ? [window().then(read), read(), list()] : [read(), window().then(read), list()],
            );
            for (const s of [a, b, labels]) {
              if (s.status === 'rejected') failed.push(String(s.reason?.errno ?? s.reason));
            }
            const seen = labels.status === 'fulfilled' ? (labels.value as string[]) : [];
            for (const s of [a, b]) {
              if (s.status === 'fulfilled') rounds.push({ ...(s.value as Round), labels: seen });
            }
          }
          // What every read saw, and what failed: a failed statement aborted the transaction.
          return c.json({ rounds, failed });
        });
      },
    };
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT}`.execute(db);
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
      VALUES (${EXT}, ${EXT}, NULL, true, true)`.execute(db);
    const ctx = { db, internals: buildExtensionInternals() } as unknown as ExtensionContext;
    const loader = {
      loaded: new Map(),
      modules: new Map(),
      lastLoadError: new Map(),
      extDirs: new Map(),
      forgetExtensionMessages: () => {},
      ctx,
    } as unknown as ExtensionLoader;
    await finalizeExtensionLoad(
      loader,
      ext,
      EXT,
      `/tmp/${EXT}`,
      app,
      ctx,
      { name: EXT, version: '1.0.0', category: 'custom', permissions: ['auth:users'] } as never,
      new Set(),
    );
    invalidateActivationCache();

    own = ((await (await call('/tenant')).json()) as { id: string }).id;
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${OTHER}::uuid, ${`rwe-${STAMP}`}, 'rwe', 'active')`.execute(db);
    for (const [tenant, label] of [
      [own, 'mine'],
      [OTHER, 'theirs'],
    ] as const) {
      await withTenantIsolation(tenant, (trx) =>
        sql`INSERT INTO ${sql.table(`zvd_${C}`)} (label, tenant_id)
            VALUES (${label}, ${tenant}::uuid)`.execute(trx),
      );
    }
  }, 120_000);

  afterAll(async () => {
    invalidateActivationCache();
    if (!db) return;
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT}`.execute(db);
    await dropTestCollection(db, C);
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER}::uuid`.execute(db);
  });

  it('every read in every round stays in the tenant, and the extension’s runs as its own role', async () => {
    expect(own).toBeTruthy();
    const bad: unknown[] = [];
    for (let hops = 0; hops < HOPS; hops++) {
      const res = await call(`/race?hops=${hops}`);
      const body = (await res.json()) as { rounds: Round[]; failed: string[] };
      // A read that ran inside the engine's window, as its login, saw the other tenant.
      const wrong = body.rounds.filter(
        (r) => r.role !== 'zveltio_ext' || r.tenants.join() !== own || r.labels.join() !== 'mine',
      );
      if (wrong.length || body.failed.length || body.rounds.length !== ROUNDS * 2) {
        bad.push({ hops, status: res.status, wrong, failed: body.failed });
      }
    }
    expect(bad).toEqual([]);
  }, 60_000);
});
