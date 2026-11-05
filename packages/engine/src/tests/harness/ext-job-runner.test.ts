/**
 * Jobs in the Deno runner (ADR 0022), end to end on the engine's queue and
 * database: a worker-isolated extension's job runs from its verified
 * `jobs.js`, in the tenant it was enqueued in, as the job's principal, through
 * the data API; it cannot reach another tenant or an undeclared collection; a
 * job waiting for a runner slot is not claimed (so cannot expire and run
 * twice); an unload kills a run, which is a failed, retried attempt. Items 3
 * and 5 of the ADR's "Verified in implementation" list.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { ManifestSchema } from '../../lib/extensions/manifest-schema.js';
import {
  _setRunnerConcurrencyForTests,
  compileJobs,
  jobQueueName,
  registerJobs,
  unregisterJobs,
  verifiedJobsCode,
} from '../../lib/extensions/jobs.js';
import { ensureDeno } from '../../lib/extensions/deno.js';
import { DDLManager, jobQueue } from '../../lib/data/index.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/index.js';
import {
  asEveryTenant,
  asTenant,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const C = `runner_${STAMP}`;
const SECRET = `runner_secret_${STAMP}`;
const EXT = `runner-ext-${STAMP}`;
const OTHER = crypto.randomUUID();
const SLUG = `runner-${OTHER.slice(0, 8)}`;

const JOBS_JS = `
export default {
  record: async (input, host) => {
    await host.collections.insert(${JSON.stringify(C)}, { label: input.label + '@' + host.timezone.length });
  },
  peek: async (input, host) => {
    const page = await host.collections.list(${JSON.stringify(C)}, { filter: JSON.stringify({ label: { eq: 'tenant-a-only' } }) });
    await host.collections.insert(${JSON.stringify(C)}, { label: 'peek-saw-' + page.records.length });
  },
  sneak: async (input, host) => {
    await host.collections.list(${JSON.stringify(SECRET)}, {});
  },
  slow: async (input, host) => {
    await new Promise((r) => setTimeout(r, input.ms));
    await host.collections.insert(${JSON.stringify(C)}, { label: input.label });
  },
};
`;

const anyInput = { type: 'object' };

d('jobs of a worker-isolated extension run in the Deno runner', () => {
  let db: Database;
  let extDir = '';

  const rows = (label: string) =>
    asEveryTenant(
      db,
      async (trx) =>
        (
          await sql<{ tenant_id: string; label: string }>`
            SELECT tenant_id, label FROM ${sql.table(`zvd_${C}`)} WHERE label LIKE ${`${label}%`}
          `.execute(trx)
        ).rows,
    );
  const send = async (job: string, input: object, retryLimit = 0) =>
    (await jobQueue()!.send(
      jobQueueName(EXT, job),
      { tenantId: OTHER, enqueuedBy: 'test', author: null, input },
      { retryLimit, retryDelay: 1, expireInSeconds: 120 },
    )) as string;
  const state = async (id: string) =>
    (await sql<{ state: string }>`SELECT state FROM pgboss.job WHERE id = ${id}::uuid`.execute(db))
      .rows[0]?.state;
  const audit = async (jobId: string) =>
    asEveryTenant(
      db,
      async (trx) =>
        (
          await sql<{ tenant_id: string | null; metadata: Record<string, unknown> }>`
            SELECT tenant_id, metadata FROM zv_audit_log
            WHERE event_type = 'extension.job.executed' AND metadata->>'jobId' = ${jobId}
          `.execute(trx)
        ).rows,
    );
  async function until<T>(probe: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
    for (let i = 0; i < 200; i++) {
      const v = await probe();
      if (done(v)) return v;
      await Bun.sleep(100);
    }
    return probe();
  }

  beforeAll(async () => {
    await ensureDeno();
    ({ db } = await getTestApp());
    for (const name of [C, SECRET]) {
      await DDLManager.createCollection(db, {
        name,
        fields: [{ name: 'label', type: 'text', required: false, unique: false, indexed: false }],
      } as never);
    }
    for (let i = 0; i < 100; i++) {
      const seen = await sql<{ a: string | null; b: string | null }>`
        SELECT to_regclass(${`zvd_${C}`}) AS a, to_regclass(${`zvd_${SECRET}`}) AS b`.execute(db);
      if (seen.rows[0]?.a && seen.rows[0]?.b) break;
      await Bun.sleep(100);
    }
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${OTHER}::uuid, ${SLUG}, ${SLUG}, 'active')`.execute(db);
    // A row of the default tenant, which a job of the other tenant must not see.
    await asTenant(db, DEFAULT_TENANT_ID, (trx) =>
      sql`INSERT INTO ${sql.table(`zvd_${C}`)} (label) VALUES ('tenant-a-only')`.execute(trx),
    );

    extDir = mkdtempSync(join(tmpdir(), 'zv-runner-ext-'));
    mkdirSync(join(extDir, 'engine'));
    writeFileSync(join(extDir, 'engine', 'jobs.js'), JOBS_JS);
    const job = (name: string, reads: string[], writes: string[]) => ({
      name,
      input: anyInput,
      reads,
      writes,
      timeoutSeconds: 20,
    });
    const manifest = ManifestSchema.parse({
      name: EXT,
      engine: { entry: 'engine/index.js', bundled: true, isolation: 'worker' },
      integrity: { jobsSha256: createHash('sha256').update(JOBS_JS).digest('hex') },
      jobs: [
        job('record', [], [C]),
        job('peek', [C], [C]),
        job('sneak', [C], [C]),
        job('slow', [], [C]),
      ],
    });
    const jobs = compileJobs(
      EXT,
      manifest as never,
      { name: EXT } as ZveltioExtension,
      true,
      verifiedJobsCode(extDir, manifest as never),
    );
    registerJobs(EXT, jobs, ['data:system']);
    // Its queues are created in the background.
    await until(
      async () =>
        Number(
          (
            await sql<{ n: string }>`SELECT count(*) AS n FROM pgboss.queue
                                    WHERE name LIKE ${`ext.${EXT}.%`}`.execute(db)
          ).rows[0]?.n,
        ),
      (n) => n === 4,
    );
  }, 180_000);

  afterAll(async () => {
    _setRunnerConcurrencyForTests(4);
    await unregisterJobs(EXT);
    if (extDir) rmSync(extDir, { recursive: true, force: true });
    if (!db) return;
    await sql`DELETE FROM pgboss.job WHERE name LIKE ${`ext.${EXT}.%`}`.execute(db);
    await asEveryTenant(db, (trx) =>
      sql`DELETE FROM zv_audit_log WHERE event_type = 'extension.job.executed'
          AND metadata->>'extension' = ${EXT}`.execute(trx),
    );
    await asEveryTenant(db, (trx) =>
      sql`DELETE FROM zv_revisions WHERE collection IN (${C}, ${SECRET})`.execute(trx),
    );
    await dropTestCollection(db, C);
    await dropTestCollection(db, SECRET);
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER}::uuid`.execute(db);
  });

  it('refuses a jobs.js that does not match its digest, and jobs without one', () => {
    writeFileSync(join(extDir, 'engine', 'jobs.js'), `${JOBS_JS}\n// changed`);
    expect(() =>
      verifiedJobsCode(extDir, {
        integrity: { jobsSha256: createHash('sha256').update(JOBS_JS).digest('hex') },
      } as never),
    ).toThrow(/tampered/);
    writeFileSync(join(extDir, 'engine', 'jobs.js'), JOBS_JS);
    expect(() =>
      compileJobs(
        EXT,
        ManifestSchema.parse({ name: EXT, jobs: [{ name: 'record', input: anyInput }] }) as never,
        { name: EXT } as ZveltioExtension,
        true,
        null,
      ),
    ).toThrow(/needs engine\/jobs\.js/);
    expect(() =>
      compileJobs(
        EXT,
        ManifestSchema.parse({ name: EXT, jobs: [{ name: 'record', input: anyInput }] }) as never,
        { name: EXT, jobs: { record: async () => {} } } as unknown as ZveltioExtension,
        true,
        new Uint8Array(),
      ),
    ).toThrow(/export it from engine\/jobs\.ts/);
  });

  it('runs in its tenant, through the data API, and is audited', async () => {
    const id = await send('record', { label: 'from-deno' });
    const got = await until(
      () => rows('from-deno'),
      (r) => r.length > 0,
    );
    expect(got).toEqual([{ tenant_id: OTHER, label: 'from-deno@3' }]);
    const a = await until(
      () => audit(id),
      (r) => r.length > 0,
    );
    expect(a[0]?.tenant_id).toBe(OTHER);
    expect(a[0]?.metadata.outcome).toBe('success');
  }, 30_000);

  it("cannot read another tenant's rows", async () => {
    await send('peek', {});
    const got = await until(
      () => rows('peek-saw-'),
      (r) => r.length > 0,
    );
    expect(got.map((r) => r.label)).toEqual(['peek-saw-0']);
  }, 30_000);

  it('cannot reach a collection its manifest does not list', async () => {
    const id = await send('sneak', {});
    const a = await until(
      () => audit(id),
      (r) => r.length > 0,
    );
    expect(a[0]?.metadata.outcome).toBe('failure');
    expect(String(a[0]?.metadata.error)).toContain('does not list in reads');
    expect(await state(id)).toBe('failed');
  }, 30_000);

  it('claims a job only when a runner slot is free', async () => {
    _setRunnerConcurrencyForTests(1);
    try {
      const first = await send('slow', { ms: 3000, label: 'slot-first' });
      await until(
        () => state(first),
        (s) => s === 'active',
      );
      const second = await send('slow', { ms: 0, label: 'slot-second' });
      // pg-boss would have claimed it within its polling interval; the runner does not.
      await Bun.sleep(2500);
      expect(await state(first)).toBe('active');
      expect(await state(second)).toBe('created');
      await until(
        () => state(second),
        (s) => s === 'completed',
      );
      expect((await rows('slot-')).map((r) => r.label).sort()).toEqual([
        'slot-first',
        'slot-second',
      ]);
    } finally {
      _setRunnerConcurrencyForTests(4);
    }
  }, 40_000);

  it('an unload kills a running job: a failed attempt, retried', async () => {
    const id = await send('slow', { ms: 15000, label: 'unloaded' }, 1);
    await until(
      () => state(id),
      (s) => s === 'active',
    );
    await Bun.sleep(500);
    await unregisterJobs(EXT);
    const s = await until(
      () => state(id),
      (v) => v === 'retry',
    );
    expect(s).toBe('retry');
    const a = await until(
      () => audit(id),
      (r) => r.length > 0,
    );
    expect(String(a[0]?.metadata.error)).toContain('unloaded');
    expect(await rows('unloaded')).toEqual([]);
  }, 40_000);
});
