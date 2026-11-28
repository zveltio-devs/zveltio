/**
 * ADR 0048 decision 1: a job's `schedule` (cron) in the manifest.
 *
 * At each occurrence the engine enqueues the job once in every active tenant
 * where the extension is active: none in a tenant that turned it off, none in a
 * suspended tenant, none for a disabled extension (whose schedule goes away).
 * Two schedulers on one database (this process's pg-boss and a second one, as a
 * second replica) still enqueue one job per tenant per occurrence.
 *
 * Real time: the schedule is `* * * * *`; the test waits for the start of a minute.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import { PgBoss } from 'pg-boss';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { finalizeExtensionLoad } from '../../lib/extensions/register.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { ManifestSchema } from '../../lib/extensions/manifest-schema.js';
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import {
  jobQueueName,
  SCHEDULE_QUEUE,
  scheduleKey,
  unregisterJobs,
} from '../../lib/extensions/jobs.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  asAuditOwner,
  asEveryTenant,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import { toJsonb } from '../../lib/jsonb.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const W = `sc_w_${STAMP}`;
const EXT = `sc-ext-${STAMP}`;
const OFF = `sc-off-${STAMP}`;
const ON = crypto.randomUUID();
const OPTED_OUT = crypto.randomUUID();
const SUSPENDED = crypto.randomUUID();

d('jobs[].schedule enqueues the job per active tenant (ADR 0048 d1)', () => {
  let db: Database;
  let second: PgBoss | undefined;

  async function load(name: string, enabled: boolean, scheduled = true): Promise<void> {
    const ext: ZveltioExtension = {
      name,
      category: 'custom',
      mountStrategy: 'subapp',
      jobs: {
        beat: (async (_input: unknown, host: { collections: { insert: Function } }) => {
          await host.collections.insert(W, { label: name });
        }) as never,
      },
      async register() {},
    };
    const parsed = ManifestSchema.parse({
      name,
      permissions: ['data:system'],
      jobs: [
        {
          name: 'beat',
          input: { type: 'object', additionalProperties: false },
          writes: [W],
          retry: { limit: 0 },
          ...(scheduled ? { schedule: '* * * * *' } : {}),
        },
      ],
    });
    await sql`DELETE FROM zv_extension_registry WHERE name = ${name}`.execute(db);
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled, manifest)
      VALUES (${name}, ${name}, NULL, true, ${enabled}, ${toJsonb(parsed)})
    `.execute(db);
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
      name,
      `/tmp/${name}`,
      new Hono(),
      ctx,
      parsed as never,
      new Set(),
    );
  }

  const queued = async (name: string) =>
    (
      await sql<{ tenant: string; by: string; author: string | null }>`
        SELECT data->>'tenantId' AS tenant, data->>'enqueuedBy' AS by, data->>'author' AS author
          FROM pgboss.job WHERE name = ${jobQueueName(name, 'beat')}
           AND data->>'tenantId' IN (${ON}, ${OPTED_OUT}, ${SUSPENDED})
      `.execute(db)
    ).rows;
  const schedules = async () =>
    (
      await sql<{ key: string }>`
        SELECT key FROM pgboss.schedule WHERE name = ${SCHEDULE_QUEUE} AND key IN (${scheduleKey(EXT, 'beat')}, ${scheduleKey(OFF, 'beat')})
      `.execute(db)
    ).rows.map((r) => r.key);
  const rows = () =>
    asEveryTenant(
      db,
      async (trx) =>
        (
          await sql<{ tenant_id: string; created_by: string | null }>`
            SELECT tenant_id, created_by FROM ${sql.table(`zvd_${W}`)}
             WHERE tenant_id IN (${ON}::uuid, ${OPTED_OUT}::uuid, ${SUSPENDED}::uuid)
          `.execute(trx)
        ).rows,
    );
  async function until<T>(probe: () => Promise<T>, done: (v: T) => boolean, ms: number) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = await probe();
      if (done(v)) return v;
      await Bun.sleep(500);
    }
    return probe();
  }

  beforeAll(async () => {
    ({ db } = await getTestApp());
    _setInlineForTests(true);
    await DDLManager.createCollection(
      db,
      {
        name: W,
        fields: [{ name: 'label', type: 'text', required: false, unique: false, indexed: false }],
      } as never,
      { extension: EXT, defaultGrants: true },
    );
    for (const [id, status] of [
      [ON, 'active'],
      [OPTED_OUT, 'active'],
      [SUSPENDED, 'suspended'],
    ] as const) {
      await sql`INSERT INTO zv_tenants (id, slug, name, status)
                VALUES (${id}::uuid, ${`sc-${id.slice(0, 8)}`}, ${id}, ${status})`.execute(db);
    }
    // A second replica's scheduler on the same database, passing every second.
    second = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      cronMonitorIntervalSeconds: 1,
    });
    second.on('error', () => {});
    await second.start();
    // Written early in a minute: that minute's occurrence is due at once (pg-boss
    // sends one from the last 60 s) and the next is 40 s or more away, so every
    // job the test sees belongs to one occurrence.
    while (new Date().getUTCSeconds() < 2 || new Date().getUTCSeconds() > 20) await Bun.sleep(250);
    await load(EXT, true);
    await load(OFF, false);
    // The firm OPTED_OUT turned EXT off for itself.
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
      VALUES (${EXT}, ${EXT}, ${OPTED_OUT}::uuid, true, false)
    `.execute(db);
    invalidateActivationCache();
  }, 120_000);

  afterAll(async () => {
    _setInlineForTests(false);
    await second?.stop({ graceful: false }).catch(() => {});
    invalidateActivationCache();
    await unregisterJobs(EXT);
    await unregisterJobs(OFF);
    if (!db) return;
    await sql`DELETE FROM pgboss.schedule WHERE name = ${SCHEDULE_QUEUE} AND key LIKE ${'sc-%'}`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM pgboss.job WHERE name LIKE ${'ext.sc-%'}`.execute(db).catch(() => {});
    await sql`DELETE FROM zv_extension_registry WHERE name IN (${EXT}, ${OFF})`.execute(db);
    await asAuditOwner(db, (trx) =>
      sql`DELETE FROM zv_audit_log WHERE resource_id LIKE ${'sc-%'}`.execute(trx),
    );
    await dropTestCollection(db, W);
    await sql`DELETE FROM zv_tenants WHERE id IN (${ON}::uuid, ${OPTED_OUT}::uuid, ${SUSPENDED}::uuid)`.execute(
      db,
    );
  });

  it('writes one schedule per scheduled job', async () => {
    const keys = await until(schedules, (k) => k.length === 2, 10_000);
    expect(keys.sort()).toEqual([scheduleKey(EXT, 'beat'), scheduleKey(OFF, 'beat')].sort());
  }, 15_000);

  it('enqueues once per active tenant where it is active, across two schedulers', async () => {
    // Every other active tenant of the database gets its own; these three are the test's.
    await until(
      () => queued(EXT),
      (j) => j.length > 0,
      90_000,
    );
    // Passes keep running inside the occurrence's minute; none may queue it again.
    await Bun.sleep(8_000);
    expect(await queued(EXT)).toEqual([{ tenant: ON, by: `ext:${EXT}:schedule`, author: null }]);
    // It ran in that tenant, with no author (ADR 0040).
    const written = await until(rows, (r) => r.length > 0, 15_000);
    expect(written).toEqual([{ tenant_id: ON, created_by: null }]);
  }, 120_000);

  it('a disabled extension enqueues nothing, and its tick drops its schedule', async () => {
    // Its tick came with EXT's (same expression).
    const keys = await until(schedules, (k) => !k.includes(scheduleKey(OFF, 'beat')), 30_000);
    expect(keys).toEqual([scheduleKey(EXT, 'beat')]);
    expect(await queued(OFF)).toEqual([]);
  }, 35_000);

  it('a job that loses its schedule on reload loses its schedule row', async () => {
    // An upgrade whose manifest drops `schedule`: the row it left would tick forever.
    await load(EXT, true, false);
    const keys = await until(schedules, (k) => k.length === 0, 10_000);
    expect(keys).toEqual([]);
  }, 15_000);
});
