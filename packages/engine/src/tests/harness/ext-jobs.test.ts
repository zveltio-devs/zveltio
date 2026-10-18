/**
 * Extension jobs (RFC v3 "Jobs"): an action enqueues, the engine runs it later.
 *
 * The enqueue is pg-boss's own INSERT on the request transaction, so a job
 * exists only if its action's request commits. The job runs out of any request,
 * in the tenant it was enqueued in, as the extension with exactly its declared
 * collections, authored by the enqueuing user, and audited. The extension is
 * loaded by the engine's own loader behind the engine's own `/ext/*` chain.
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
import { ManifestSchema } from '../../lib/extensions/manifest-schema.js';
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import { jobQueueName, unregisterJobs } from '../../lib/extensions/jobs.js';
import { DDLManager, jobQueue } from '../../lib/data/index.js';
import {
  createRequestScopedDb,
  getCurrentDomainOrNull,
  withTenantIsolation,
} from '../../lib/tenancy/index.js';
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

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const C = `job_${STAMP}`;
const RES = `job_res_${STAMP}`;
const EXT = `job-ext-${STAMP}`;
const NOSYS = `job-nosys-${STAMP}`;
const REFUSED = `job-refused-${STAMP}`;
const OTHER = crypto.randomUUID();
const SLUG = `jobs-${OTHER.slice(0, 8)}`;

const labelInput = {
  type: 'object',
  properties: { label: { type: 'string', minLength: 1 } },
  required: ['label'],
  additionalProperties: false,
};

d('extension jobs run after the request commits, in its tenant, as the extension', () => {
  let engine: Hono;
  let db: Database;
  let app: Hono;
  let member: { cookie: string; userId: string };
  /** The domain the `record` job ran as. */
  let jobDomain: string | null = null;

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
    await sql`DELETE FROM zv_extension_registry WHERE name = ${ext.name}`.execute(db);
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
      VALUES (${ext.name}, ${ext.name}, NULL, true, true)
    `.execute(db);
    const ctx = { db, internals: buildExtensionInternals() } as unknown as ExtensionContext;
    await finalizeExtensionLoad(
      loader(ctx),
      ext,
      ext.name,
      `/tmp/${ext.name}`,
      app,
      ctx,
      ManifestSchema.parse({ name: ext.name, ...manifest }) as never,
      new Set(),
    );
  }

  /** An action request in the second tenant. */
  const act = (ext: string, name: string, body: unknown) =>
    app.request(`/ext/${ext}/actions/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: member.cookie, 'X-Tenant-Slug': SLUG },
      body: JSON.stringify(body),
    });
  const rowsLabelled = (label: string) =>
    asEveryTenant(
      db,
      async (trx) =>
        (
          await sql<{ tenant_id: string; created_by: string | null }>`
          SELECT tenant_id, created_by FROM ${sql.table(`zvd_${C}`)} WHERE label = ${label}
        `.execute(trx)
        ).rows,
    );
  /** Jobs pg-boss holds for `ext`/`job` with this label, in any state. */
  const queued = async (ext: string, job: string, label: string) =>
    Number(
      (
        await sql<{ n: string }>`
          SELECT count(*) AS n FROM pgboss.job
          WHERE name = ${jobQueueName(ext, job)} AND data->'input'->>'label' = ${label}
        `.execute(db)
      ).rows[0]?.n,
    );
  const audits = (job: string) =>
    asEveryTenant(
      db,
      async (trx) =>
        (
          await sql<{
            user_id: string | null;
            tenant_id: string | null;
            metadata: Record<string, unknown>;
          }>`
          SELECT user_id, tenant_id, metadata FROM zv_audit_log
          WHERE event_type = 'extension.job.executed' AND resource_id = ${`${EXT}:${job}`}
          ORDER BY created_at
        `.execute(trx)
        ).rows,
    );
  /** A job as `enqueue` would have written it, sent straight to pg-boss. */
  const sendRaw = async (ext: string, job: string, data: object, retryLimit = 0) =>
    (await jobQueue()!.send(jobQueueName(ext, job), data, { retryLimit, retryDelay: 1 })) as string;
  const auditOf = (jobId: string) =>
    asEveryTenant(
      db,
      async (trx) =>
        (
          await sql<{
            user_id: string | null;
            tenant_id: string | null;
            metadata: Record<string, unknown>;
          }>`
          SELECT user_id, tenant_id, metadata FROM zv_audit_log
          WHERE event_type = 'extension.job.executed' AND metadata->>'jobId' = ${jobId}
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
    // Nothing on the collection: whatever the job writes, the extension's authority wrote.
    member = await createMemberSession(engine, db, {
      grants: [{ collection: RES, actions: ['execute'] }],
    });
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${OTHER}::uuid, ${SLUG}, ${SLUG}, 'active')`.execute(db);
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role)
              VALUES (${OTHER}::uuid, ${member.userId}, 'member')`.execute(db);

    app = new Hono();
    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));

    const action = (name: string, enqueues: string[]) => ({
      name,
      permission: { resource: RES },
      input: { type: 'object' },
      enqueues,
    });
    // Loaded from inside a tenant's work, as an extension enabled by a request
    // is: the worker pg-boss starts here must not run its jobs in that context.
    await withTenantIsolation('00000000-0000-0000-0000-000000000001', () =>
      load(
        {
          name: EXT,
          category: 'custom',
          mountStrategy: 'subapp',
          actions: {
            queue: async (input, host) => ({ id: await host.enqueue('record', input) }),
            queueThenThrow: async (input, host) => {
              await host.enqueue('record', input);
              throw new Error('the action failed after enqueueing');
            },
            queueUndeclared: (input, host) => host.enqueue('record', input),
            queueSneak: (input, host) => host.enqueue('sneak', input),
            queueRaw: (input, host) => host.enqueue('raw', input),
          },
          jobs: {
            record: async (input, host) => {
              jobDomain = getCurrentDomainOrNull();
              await host.collections.insert(C, input as Record<string, unknown>);
            },
            sneak: async (input, host) => {
              await host.collections.insert(C, input as Record<string, unknown>);
            },
            // First-party code reaching the job's transaction past the host, as `ctx.db` does.
            raw: async (input) => {
              await sql`INSERT INTO ${sql.table(`zvd_${C}`)} (label) VALUES (${(input as { label: string }).label})`.execute(
                createRequestScopedDb(db),
              );
            },
          },
          async register() {},
        },
        {
          permissions: ['data:system'],
          resources: [RES],
          actions: [
            action('queue', ['record']),
            action('queueThenThrow', ['record']),
            action('queueUndeclared', []),
            action('queueSneak', ['sneak']),
            action('queueRaw', ['raw']),
          ],
          jobs: [
            { name: 'record', input: labelInput, writes: [C], retry: { limit: 0 } },
            { name: 'sneak', input: labelInput, retry: { limit: 0 } },
            { name: 'raw', input: labelInput, reads: [C], retry: { limit: 0 } },
          ],
        },
      ),
    );
    await load(
      {
        name: NOSYS,
        category: 'custom',
        mountStrategy: 'subapp',
        actions: { queue: (input, host) => host.enqueue('record', input) },
        jobs: {
          record: async (input, host) => {
            await host.collections.insert(C, input as Record<string, unknown>);
          },
        },
        async register() {},
      },
      {
        resources: [RES],
        actions: [action('queue', ['record'])],
        jobs: [{ name: 'record', input: labelInput, writes: [C] }],
      },
    );
    invalidateActivationCache();
  }, 60_000);

  afterAll(async () => {
    invalidateActivationCache();
    await unregisterJobs(EXT);
    await unregisterJobs(NOSYS);
    if (!db) return;
    await sql`DELETE FROM zv_extension_registry WHERE name IN (${EXT}, ${NOSYS}, ${REFUSED})`.execute(
      db,
    );
    await asEveryTenant(db, (trx) =>
      sql`DELETE FROM zv_audit_log WHERE event_type = 'extension.job.executed'`.execute(trx),
    );
    await asEveryTenant(db, (trx) =>
      sql`DELETE FROM zv_revisions WHERE collection = ${C}`.execute(trx),
    );
    await dropTestCollection(db, C);
    await sql`DELETE FROM zv_tenant_users WHERE tenant_id = ${OTHER}::uuid`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER}::uuid`.execute(db);
  });

  it('a job enqueued by an action whose request fails is never queued', async () => {
    expect((await act(EXT, 'queueThenThrow', { label: 'rolled-back' })).status).toBe(500);
    expect(await queued(EXT, 'record', 'rolled-back')).toBe(0);
  });

  it('runs the job after the commit, in the enqueuing tenant, authored by the enqueuer', async () => {
    const res = await act(EXT, 'queue', { label: 'by-job' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { id: string } }).result.id).toBeString();
    const rows = await until(
      () => rowsLabelled('by-job'),
      (r) => r.length > 0,
    );
    expect(rows).toEqual([{ tenant_id: OTHER, created_by: member.userId }]);
    // Its domain too, not whatever pg-boss resumed in: permission helpers answer for it.
    expect(jobDomain).toBe(OTHER);
    // Run once, recorded with its originator, in its tenant.
    const runs = await until(
      () => audits('record'),
      (r) => r.length > 0,
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      user_id: member.userId,
      tenant_id: OTHER,
      metadata: { extension: EXT, job: 'record', outcome: 'success', enqueuedBy: member.userId },
    });
    // Queued once, through the request transaction's driver: the zero counts are not vacuous.
    expect(await queued(EXT, 'record', 'by-job')).toBe(1);
    // And the job queued by the failed request above never ran.
    expect(await rowsLabelled('rolled-back')).toEqual([]);
  });

  it('refuses a job the action does not declare in enqueues', async () => {
    expect((await act(EXT, 'queueUndeclared', { label: 'undeclared' })).status).toBe(500);
    expect(await queued(EXT, 'record', 'undeclared')).toBe(0);
  });

  it('refuses an input the job schema does not accept, at enqueue', async () => {
    for (const body of [{}, { label: '' }, { label: 7 }, { label: 'x', extra: true }]) {
      expect((await act(EXT, 'queue', body)).status).toBe(500);
    }
    expect(await queued(EXT, 'record', 'x')).toBe(0);
  });

  it('refuses to enqueue for an extension without data:system', async () => {
    expect((await act(NOSYS, 'queue', { label: 'nosys' })).status).toBe(500);
    expect(await queued(NOSYS, 'record', 'nosys')).toBe(0);
  });

  it('fails, and audits the failure of, a job reaching a collection it does not declare', async () => {
    expect((await act(EXT, 'queueSneak', { label: 'sneaked' })).status).toBe(200);
    const runs = await until(
      () => audits('sneak'),
      (r) => r.length > 0,
    );
    expect(runs[0]?.metadata).toMatchObject({ outcome: 'failure', job: 'sneak' });
    expect(String(runs[0]?.metadata.error)).toContain('does not list in writes');
    expect(await rowsLabelled('sneaked')).toEqual([]);
  });

  it('holds a job’s own statements to its declared collections in the database', async () => {
    // `raw` declares `reads` only: the policy refuses the INSERT the host never saw.
    expect((await act(EXT, 'queueRaw', { label: 'raw-write' })).status).toBe(200);
    const runs = await until(
      () => audits('raw'),
      (r) => r.length > 0,
    );
    expect(runs[0]?.metadata).toMatchObject({ outcome: 'failure', job: 'raw' });
    expect(await rowsLabelled('raw-write')).toEqual([]);
  });

  it('does not run, nor retry, a job whose tenant was purged since the enqueue', async () => {
    const gone = crypto.randomUUID();
    const id = await sendRaw(
      EXT,
      'record',
      {
        tenantId: gone,
        enqueuedBy: member.userId,
        author: member.userId,
        input: { label: 'purged' },
      },
      3,
    );
    const runs = await until(
      () => auditOf(id),
      (r) => r.length > 0,
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      tenant_id: null,
      metadata: { outcome: 'failure', tenantId: gone },
    });
    expect(String(runs[0]?.metadata.error)).toContain('is gone');
    const state = await until(
      async () =>
        (
          await sql<{ state: string; retry_count: number }>`
            SELECT state, retry_count FROM pgboss.job WHERE id = ${id}::uuid
          `.execute(db)
        ).rows[0],
      (r) => r?.state === 'completed',
    );
    expect(state).toEqual({ state: 'completed', retry_count: 0 });
    expect(await rowsLabelled('purged')).toEqual([]);
  });

  it('does not run a job of an extension that lost data:system after the enqueue', async () => {
    // Queued while it held the capability; NOSYS is loaded without it.
    const id = await sendRaw(NOSYS, 'record', {
      tenantId: OTHER,
      enqueuedBy: member.userId,
      author: member.userId,
      input: { label: 'revoked' },
    });
    const runs = await until(
      () => auditOf(id),
      (r) => r.length > 0,
    );
    expect(runs[0]?.metadata).toMatchObject({ outcome: 'failure' });
    expect(String(runs[0]?.metadata.error)).toContain('no longer holds data:system');
    expect(await rowsLabelled('revoked')).toEqual([]);
  });

  it('writes the audit row when the enqueuer is gone or is a key with no issuer', async () => {
    const key = `apikey:${crypto.randomUUID()}`;
    const ghost = await sendRaw(EXT, 'sneak', {
      tenantId: OTHER,
      enqueuedBy: 'ghost-user',
      author: 'ghost-user',
      input: { label: 'ghost' },
    });
    const keyed = await sendRaw(EXT, 'sneak', {
      tenantId: OTHER,
      enqueuedBy: key,
      author: null,
      input: { label: 'keyed' },
    });
    const ghostRuns = await until(
      () => auditOf(ghost),
      (r) => r.length > 0,
    );
    expect(ghostRuns[0]).toMatchObject({
      user_id: null,
      tenant_id: OTHER,
      metadata: { author: 'ghost-user', enqueuedBy: 'ghost-user' },
    });
    const keyedRuns = await until(
      () => auditOf(keyed),
      (r) => r.length > 0,
    );
    expect(keyedRuns[0]).toMatchObject({
      user_id: null,
      tenant_id: OTHER,
      metadata: { api_key: key, enqueuedBy: key, author: null },
    });
  });

  it('refuses to load when the manifest jobs and the module disagree', async () => {
    const job = { name: 'go', input: { type: 'object' } };
    const ext = (jobs: ZveltioExtension['jobs']) =>
      ({
        name: REFUSED,
        category: 'custom',
        mountStrategy: 'subapp',
        jobs,
        async register() {},
      }) as const;
    const go = async () => {};
    await expect(load(ext({}), { jobs: [job] })).rejects.toThrow('has no implementation');
    await expect(load(ext({ go }), {})).rejects.toThrow('not declared');
    // The manifest refuses an unusable schema and an action enqueueing an undeclared job.
    expect(
      ManifestSchema.safeParse({ name: REFUSED, jobs: [{ ...job, input: { type: 'bogus' } }] })
        .success,
    ).toBe(false);
    expect(
      ManifestSchema.safeParse({
        name: REFUSED,
        resources: [RES],
        actions: [{ name: 'a', permission: { resource: RES }, input: {}, enqueues: ['nope'] }],
      }).success,
    ).toBe(false);
  });
});
