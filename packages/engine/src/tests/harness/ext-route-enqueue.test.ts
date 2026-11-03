/**
 * ADR 0018: a public route enqueues a job; the job writes.
 *
 * An inbound signed webhook has no user, so it cannot run an action, and a
 * `writtenBy: "actions"` collection refuses every path but its extension's
 * actions and jobs. `ctx.internals.enqueue(c, job, input)` lets the handler of
 * one of the extension's `publicRoutes` queue a job that names the route in
 * `fromPublicRoutes`: on the request transaction (it rolls back with the
 * request), in the request's tenant, with no author. Anywhere else it throws.
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
import { jobQueueName, unregisterJobs } from '../../lib/extensions/jobs.js';
import { DDLManager } from '../../lib/data/index.js';
import { getAuth } from '../../lib/auth.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import {
  asEveryTenant,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import { toJsonb } from '../../lib/jsonb.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
/** Declared by EXT, written only by its actions and jobs. */
const W = `rq_w_${STAMP}`;
const EXT = `rq-ext-${STAMP}`;
const NOSYS = `rq-nosys-${STAMP}`;
const TENANT = crypto.randomUUID();
const SLUG = `rq-${TENANT.slice(0, 8)}`;

const labelInput = {
  type: 'object',
  properties: { label: { type: 'string', minLength: 1 } },
  required: ['label'],
  additionalProperties: false,
};

d('a public route enqueues a job that writes a writtenBy collection (ADR 0018)', () => {
  let engine: Hono;
  let db: Database;
  let app: Hono;
  let member: { cookie: string; userId: string };
  /** A context kept from an earlier request. */
  let kept: Context | undefined;
  /** An enqueue the handler left running after its answer. */
  let late: Promise<string> | undefined;

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

  /** The handler's answer: the job id, or the refusal's message (418). */
  const enqueueing = (ctx: SdkContext, job: string, after?: () => never) => async (c: Context) => {
    try {
      const id = await ctx.internals!.enqueue!(c, job, await c.req.json());
      after?.();
      return c.json({ id });
    } catch (err) {
      if (after) throw err;
      return c.json({ error: (err as Error).message }, 418);
    }
  };

  /** Routes as the extension registers them, behind the engine's own `/ext/*` chain. */
  const routes = (ctx: SdkContext) => (r: Hono) => {
    r.post('/webhooks/in', enqueueing(ctx, 'ingest'));
    r.post(
      '/webhooks/throw',
      enqueueing(ctx, 'ingest', () => {
        throw new Error('the handler failed after enqueueing');
      }),
    );
    r.post('/webhooks/internal', enqueueing(ctx, 'internal'));
    // Public through `/webhooks/*`, but not a route the job names.
    r.post('/webhooks/contact', enqueueing(ctx, 'ingest'));
    r.post('/webhooks/ghost', enqueueing(ctx, 'ghost'));
    r.post('/open', enqueueing(ctx, 'ingest'));
    r.post('/private', enqueueing(ctx, 'ingest'));
    r.post('/webhooks/keep', (c) => {
      kept = c;
      return c.json({});
    });
    r.post('/webhooks/late', (c) => {
      late = Bun.sleep(300).then(() => ctx.internals!.enqueue!(c, 'ingest', { label: 'late' }));
      late.catch(() => {});
      return c.json({});
    });
    r.post('/webhooks/stale', async (c) => {
      try {
        return c.json({ id: await ctx.internals!.enqueue!(kept!, 'ingest', { label: 'stale' }) });
      } catch (err) {
        return c.json({ error: (err as Error).message }, 418);
      }
    });
  };

  const post = (ext: string, path: string, body: unknown, cookie?: string) =>
    app.request(`/ext/${ext}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Tenant-Slug': SLUG,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  const errorOf = async (res: Response) => ((await res.json()) as { error?: string }).error;
  const queued = async (ext: string, job: string, label: string) =>
    Number(
      (
        await sql<{ n: string }>`
          SELECT count(*) AS n FROM pgboss.job
          WHERE name = ${jobQueueName(ext, job)} AND data->'input'->>'label' = ${label}
        `.execute(db)
      ).rows[0]?.n,
    );
  const rowsLabelled = (label: string) =>
    asEveryTenant(
      db,
      async (trx) =>
        (
          await sql<{ tenant_id: string; created_by: string | null }>`
          SELECT tenant_id, created_by FROM ${sql.table(`zvd_${W}`)} WHERE label = ${label}
        `.execute(trx)
        ).rows,
    );
  const audit = (type: string, jobId: string) =>
    asEveryTenant(
      db,
      async (trx) =>
        (
          await sql<{ user_id: string | null; tenant_id: string | null; metadata: object }>`
          SELECT user_id, tenant_id, metadata FROM zv_audit_log
          WHERE event_type = ${type} AND metadata->>'jobId' = ${jobId}
        `.execute(trx)
        ).rows,
    );
  async function until<T>(probe: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
    for (let i = 0; i < 150; i++) {
      const v = await probe();
      if (done(v)) return v;
      await Bun.sleep(100);
    }
    return probe();
  }

  beforeAll(async () => {
    ({ app: engine, db } = await getTestApp());
    _setInlineForTests(true);
    await DDLManager.createCollection(
      db,
      {
        name: W,
        writtenBy: 'actions',
        fields: [{ name: 'label', type: 'text', required: false, unique: false, indexed: false }],
      } as never,
      { extension: EXT, defaultGrants: true },
    );
    member = await createMemberSession(engine, db, {});
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${TENANT}::uuid, ${SLUG}, ${SLUG}, 'active')`.execute(db);
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role)
              VALUES (${TENANT}::uuid, ${member.userId}, 'member')`.execute(db);

    app = new Hono();
    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));

    const ingest = async (input: unknown, host: { collections: { insert: Function } }) => {
      await host.collections.insert(W, input as Record<string, unknown>);
    };
    const manifest = (permissions: string[]) => ({
      permissions,
      publicRoutes: ['/webhooks/*', '/webhooks/in', '/webhooks/throw', '/webhooks/late', '/open'],
      jobs: [
        {
          name: 'ingest',
          input: labelInput,
          writes: [W],
          fromPublicRoutes: ['/webhooks/in', '/webhooks/throw', '/webhooks/late'],
          retry: { limit: 0 },
        },
        { name: 'internal', input: labelInput, writes: [W], retry: { limit: 0 } },
      ],
    });
    for (const [name, permissions] of [
      [EXT, ['data:system']],
      [NOSYS, []],
    ] as const) {
      await load(
        {
          name,
          category: 'custom',
          mountStrategy: 'subapp',
          jobs: { ingest: ingest as never, internal: ingest as never },
          async register(r, ctx) {
            routes(ctx as SdkContext)(r as Hono);
          },
        },
        manifest([...permissions]),
      );
    }
    invalidateActivationCache();
  }, 60_000);

  afterAll(async () => {
    invalidateActivationCache();
    await unregisterJobs(EXT);
    await unregisterJobs(NOSYS);
    if (!db) return;
    await sql`DELETE FROM zv_extension_registry WHERE name IN (${EXT}, ${NOSYS})`.execute(db);
    await asEveryTenant(db, (trx) =>
      sql`DELETE FROM zv_audit_log WHERE resource_id LIKE ${`${EXT}:%`}`.execute(trx),
    );
    await sql`DELETE FROM pgboss.job WHERE name LIKE ${'ext.rq-%'}`.execute(db).catch(() => {});
    await dropTestCollection(db, W);
    await sql`DELETE FROM zv_tenant_users WHERE tenant_id = ${TENANT}::uuid`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id = ${TENANT}::uuid`.execute(db);
  });

  it('enqueues from a declared public route; the job writes the flagged collection', async () => {
    const res = await post(EXT, '/webhooks/in', { label: 'hook-ok' });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const rows = await until(
      () => rowsLabelled('hook-ok'),
      (r) => r.length > 0,
    );
    // In the request's tenant, with no author: no user enqueued it.
    expect(rows).toEqual([{ tenant_id: TENANT, created_by: null }]);
    const ran = await until(
      () => audit('extension.job.executed', id),
      (r) => r.length > 0,
    );
    expect(ran[0]!.metadata).toMatchObject({
      enqueuedBy: `ext:${EXT}:route`,
      author: null,
      outcome: 'success',
    });
    const enq = await until(
      () => audit('extension.job.enqueued', id),
      (r) => r.length > 0,
    );
    expect(enq[0]).toMatchObject({ tenant_id: TENANT });
    expect(enq[0]!.metadata).toMatchObject({ extension: `ext:${EXT}`, route: '/webhooks/in' });
  }, 30_000);

  it('rolls the enqueue back with the request', async () => {
    const res = await post(EXT, '/webhooks/throw', { label: 'hook-throw' });
    expect(res.status).toBe(500);
    expect(await queued(EXT, 'ingest', 'hook-throw')).toBe(0);
    // Its audit row was written on the same transaction, and went with it.
    const rows = await asEveryTenant(
      db,
      async (trx) =>
        (
          await sql`SELECT 1 FROM zv_audit_log WHERE event_type = 'extension.job.enqueued'
                    AND metadata->>'route' = '/webhooks/throw'
                    AND metadata->>'extension' = ${`ext:${EXT}`}`.execute(trx)
        ).rows,
    );
    expect(rows).toEqual([]);
  });

  it('refuses a job that does not name the route, and a route the job does not name', async () => {
    const internal = await post(EXT, '/webhooks/internal', { label: 'hook-internal' });
    expect(internal.status).toBe(418);
    expect(await errorOf(internal)).toContain('fromPublicRoutes');
    const contact = await post(EXT, '/webhooks/contact', { label: 'hook-contact' });
    expect(contact.status).toBe(418);
    expect(await errorOf(contact)).toContain('fromPublicRoutes');
    const open = await post(EXT, '/open', { label: 'hook-open' });
    expect(open.status).toBe(418);
    expect(await errorOf(open)).toContain('fromPublicRoutes');
    const ghost = await post(EXT, '/webhooks/ghost', { label: 'hook-ghost' });
    expect(await errorOf(ghost)).toContain('declares no such job');
    expect(await queued(EXT, 'internal', 'hook-internal')).toBe(0);
    expect(await queued(EXT, 'ingest', 'hook-open')).toBe(0);
  });

  it('refuses input the job schema refuses', async () => {
    const res = await post(EXT, '/webhooks/in', { label: '' });
    expect(res.status).toBe(418);
    expect(await errorOf(res)).toContain("job's schema");
  });

  it('refuses a session route, and a context kept from another request', async () => {
    const priv = await post(EXT, '/private', { label: 'hook-private' }, member.cookie);
    expect(priv.status).toBe(418);
    expect(await errorOf(priv)).toContain('publicRoutes');
    expect((await post(EXT, '/webhooks/keep', {})).status).toBe(200);
    const stale = await post(EXT, '/webhooks/stale', {});
    expect(stale.status).toBe(418);
    expect(await errorOf(stale)).toContain('publicRoutes');
    expect(await queued(EXT, 'ingest', 'hook-private')).toBe(0);
    expect(await queued(EXT, 'ingest', 'stale')).toBe(0);
  });

  it('refuses an enqueue the handler leaves running after its answer', async () => {
    expect((await post(EXT, '/webhooks/late', {})).status).toBe(200);
    await expect(late!).rejects.toThrow('its request is over');
    expect(await queued(EXT, 'ingest', 'late')).toBe(0);
  });

  it('refuses an extension without data:system', async () => {
    const res = await post(NOSYS, '/webhooks/in', { label: 'hook-nosys' });
    expect(res.status).toBe(418);
    // The capability gate answers first; the job registry refuses it too.
    expect(await errorOf(res)).toContain('used ctx.internals.enqueue without declaring');
    expect(await queued(NOSYS, 'ingest', 'hook-nosys')).toBe(0);
  });
});
