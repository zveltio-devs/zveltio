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
import { readGranted, recordConsent } from '../../lib/extensions/consent.js';
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
  net: async (input, host) => {
    let label;
    try {
      const res = await host.fetch(input.url, { method: 'POST', body: 'ping' });
      label = 'net-' + input.tag + '-' + res.status + '-' + (await res.text());
    } catch (e) {
      label = 'net-' + input.tag + '-ERR-' + e.message;
    }
    await host.collections.insert(${JSON.stringify(C)}, { label });
  },
  twice: async (input, host) => {
    const once = async (n) => {
      let label;
      try {
        label = 'twice-' + n + '-' + (await host.fetch('http://1.1.1.1/' + n)).status;
      } catch (e) {
        label = 'twice-' + n + '-ERR-' + e.message;
      }
      await host.collections.insert(${JSON.stringify(C)}, { label });
    };
    await once(1);
    // Until the test, having revoked the consent, says go.
    const go = JSON.stringify({ label: { eq: 'twice-go' } });
    while ((await host.collections.list(${JSON.stringify(C)}, { filter: go })).records.length === 0) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await once(2);
  },
  slotnet: async (input, host) => {
    let label;
    try {
      const bound = await host.egress.slot('provider');
      const res = await host.fetch(input.url);
      label = 'bound-' + input.tag + '-[' + bound.join(',') + ']-' + res.status;
    } catch (e) {
      label = 'bound-' + input.tag + '-ERR-' + e.message;
    }
    await host.collections.insert(${JSON.stringify(C)}, { label });
  },
  badArgs: async (input, host) => {
    await host.collections.read(42, 'x');
  },
  slow: async (input, host) => {
    await new Promise((r) => setTimeout(r, input.ms));
    await host.collections.insert(${JSON.stringify(C)}, { label: input.label });
  },
};
`;

const anyInput = { type: 'object' };
const GRANTED = [
  'data:system',
  'egress:1.1.1.1',
  'egress:localhost',
  'egress:nonexistent.invalid',
  'egress:[64:ff9b::a00:1]',
];

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
        job('badArgs', [C], []),
        {
          ...job('net', [C], [C]),
          timeoutSeconds: 120,
          egress: ['1.1.1.1', '8.8.8.8', 'localhost', 'nonexistent.invalid', '[64:ff9b::a00:1]'],
        },
        { ...job('twice', [C], [C]), timeoutSeconds: 60, egress: ['1.1.1.1'] },
        { ...job('slotnet', [C], [C]), egress: ['1.1.1.1'], egressSlots: ['provider'] },
      ],
    });
    const jobs = compileJobs(
      EXT,
      manifest as never,
      { name: EXT } as ZveltioExtension,
      true,
      verifiedJobsCode(extDir, manifest as never),
    );
    // Every egress authority approved but 8.8.8.8 (ADR 0022 decision 5), on
    // the registry row a run reads at each fetch (ADR 0023 decision 4).
    await sql`INSERT INTO zv_extension_registry (name, display_name, is_installed, is_enabled)
              VALUES (${EXT}, ${EXT}, true, true)`.execute(db);
    await recordConsent(db, EXT, GRANTED);
    registerJobs(EXT, jobs, GRANTED);
    // Its queues are created in the background.
    await until(
      async () =>
        Number(
          (
            await sql<{ n: string }>`SELECT count(*) AS n FROM pgboss.queue
                                    WHERE name LIKE ${`ext.${EXT}.%`}`.execute(db)
          ).rows[0]?.n,
        ),
      (n) => n === 7,
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
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT}`.execute(db);
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
    // An inline (first-party) extension: a job with egress goes to the runner, the rest stay inline.
    const mixed = ManifestSchema.parse({
      name: EXT,
      jobs: [
        { name: 'record', input: anyInput },
        { name: 'net', input: anyInput, egress: ['api.x.com'] },
      ],
    });
    const compiled = compileJobs(
      EXT,
      mixed as never,
      { name: EXT, jobs: { record: async () => {} } } as unknown as ZveltioExtension,
      false,
      new Uint8Array([1]),
    );
    expect(compiled.get('record')?.runner).toBeUndefined();
    expect(compiled.get('net')?.runner?.egress).toEqual(['api.x.com']);
    expect(() =>
      compileJobs(
        EXT,
        mixed as never,
        { name: EXT, jobs: { record: async () => {} } } as unknown as ZveltioExtension,
        false,
        null,
      ),
    ).toThrow(/job "net" runs in the Deno runner, which needs engine\/jobs\.js/);
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

  it('waits while its runner does not answer: not claimed, no retry spent (ADR 0022)', async () => {
    const saved = [process.env.ZVELTIO_EXT_TRANSPORT, process.env.ZVELTIO_EXT_RUNNER_SOCKET];
    process.env.ZVELTIO_EXT_TRANSPORT = 'runner';
    process.env.ZVELTIO_EXT_RUNNER_SOCKET = join(tmpdir(), `zv-no-runner-${STAMP}.sock`);
    let id = '';
    try {
      id = await send('record', { label: 'runner-down' });
      // Several pump passes (every 2 s): a claim would fail it at once (retryLimit 0).
      await Bun.sleep(5000);
      expect(await state(id)).toBe('created');
    } finally {
      const [t, s] = saved;
      if (t === undefined) delete process.env.ZVELTIO_EXT_TRANSPORT;
      else process.env.ZVELTIO_EXT_TRANSPORT = t;
      if (s === undefined) delete process.env.ZVELTIO_EXT_RUNNER_SOCKET;
      else process.env.ZVELTIO_EXT_RUNNER_SOCKET = s;
    }
    // Back on a transport that runs it: the same job runs, it was never dropped.
    expect(
      await until(
        () => state(id),
        (st) => st === 'completed',
      ),
    ).toBe('completed');
  }, 60_000);

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
    // The audit row is written before the queue settles the job.
    expect(
      await until(
        () => state(id),
        (st) => st === 'failed',
      ),
    ).toBe('failed');
  }, 30_000);

  it('answers malformed host-call arguments with an error, at once', async () => {
    const t = Date.now();
    const id = await send('badArgs', {});
    const a = await until(
      () => audit(id),
      (r) => r.length > 0,
    );
    expect(String(a[0]?.metadata.error)).toContain('collection must be a string');
    // Not the 20 s timeout: the refusal reached the job as its error.
    expect(Date.now() - t).toBeLessThan(15_000);
  }, 30_000);

  describe('egress (ADR 0022 decision 3)', () => {
    const real = globalThis.fetch;
    const seen: string[] = [];
    beforeAll(() => {
      // The network under the guard: what reaches it was allowed by everything above it.
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        seen.push(url.href);
        if (url.pathname === '/redirect') {
          return new Response(null, { status: 302, headers: { location: 'http://8.8.8.8/' } });
        }
        if (url.pathname === '/to-public') {
          return new Response(null, { status: 302, headers: { location: 'http://1.1.1.1/' } });
        }
        const body = init?.body ? new TextDecoder().decode(init.body as Uint8Array) : '';
        return new Response(`pong:${body}`, { status: 200 });
      }) as typeof fetch;
    });
    afterAll(() => {
      globalThis.fetch = real;
    });
    const net = async (tag: string, url: string) => {
      await send('net', { tag, url });
      const got = await until(
        () => rows(`net-${tag}-`),
        (r) => r.length > 0,
      );
      expect(got[0]?.tenant_id).toBe(OTHER);
      return got[0]!.label;
    };

    it('reaches a consented authority through the engine', async () => {
      expect(await net('ok', 'http://1.1.1.1/hook')).toBe('net-ok-200-pong:ping');
      expect(seen).toContain('http://1.1.1.1/hook');
    }, 40_000);

    it('refuses a declared authority nobody approved', async () => {
      expect(await net('unconsented', 'http://8.8.8.8/')).toContain(
        "8.8.8.8 is not in this function's egress",
      );
    }, 40_000);

    it('refuses an undeclared authority, and a redirect to an unapproved one', async () => {
      expect(await net('undeclared', 'http://9.9.9.9/')).toContain('is not in');
      expect(await net('redirect', 'http://1.1.1.1/redirect')).toContain('8.8.8.8 is not in');
    }, 40_000);

    it('refuses a name resolving to a private address, and one that does not resolve', async () => {
      expect(await net('private', 'http://localhost/')).toContain('private address blocked');
      expect(await net('nxdomain', 'http://nonexistent.invalid/')).toContain('did not resolve');
    }, 40_000);

    it('pins even with a proxy configured', async () => {
      process.env.HTTPS_PROXY = 'http://1.1.1.1:3128';
      process.env.HTTP_PROXY = 'http://1.1.1.1:3128';
      try {
        expect(await net('proxied', 'http://nonexistent.invalid/')).toContain('did not resolve');
      } finally {
        delete process.env.HTTPS_PROXY;
        delete process.env.HTTP_PROXY;
      }
    }, 40_000);

    it('a revoked consent cuts the next fetch of a run already going (ADR 0023 decision 4)', async () => {
      await send('twice', {});
      expect(
        (
          await until(
            () => rows('twice-1-'),
            (r) => r.length > 0,
          )
        )[0]?.label,
      ).toBe('twice-1-200');
      // What the approve-capabilities route writes: the same set without 1.1.1.1.
      await recordConsent(
        db,
        EXT,
        GRANTED.filter((c) => c !== 'egress:1.1.1.1'),
      );
      try {
        await asTenant(db, OTHER, (trx) =>
          sql`INSERT INTO ${sql.table(`zvd_${C}`)} (label) VALUES ('twice-go')`.execute(trx),
        );
        const second = await until(
          () => rows('twice-2-'),
          (r) => r.length > 0,
        );
        // Nothing consented is left to this job: the bridge refuses before any network.
        expect(second[0]?.label).toStartWith('twice-2-ERR-[egress]');
        expect(seen).not.toContain('http://1.1.1.1/2');
      } finally {
        await recordConsent(db, EXT, GRANTED);
      }
    }, 40_000);

    describe('an operator-bound slot (ADR 0026)', () => {
      const slot = async (tag: string, url: string, binding: string | null) => {
        await recordConsent(db, EXT, binding ? [...GRANTED, binding] : GRANTED);
        try {
          await send('slotnet', { tag, url });
          return (
            await until(
              () => rows(`bound-${tag}-`),
              (r) => r.length > 0,
            )
          )[0]!.label;
        } finally {
          await recordConsent(db, EXT, GRANTED);
        }
      };

      it('unbound: no egress, and the slot reads []', async () => {
        expect(await slot('unbound', 'http://2.2.2.2/', null)).toContain(
          "2.2.2.2 is not in this function's egress",
        );
        // A job that reads the slot first learns it is off.
        expect(await slot('unbound-static', 'http://1.1.1.1/', null)).toBe(
          'bound-unbound-static-[]-200',
        );
      }, 40_000);

      it('bound: exactly its authorities, a redirect included', async () => {
        const b = 'egress:provider=2.2.2.2';
        expect(await slot('bound', 'http://2.2.2.2/x', b)).toBe('bound-bound-[2.2.2.2]-200');
        expect(await slot('other', 'http://3.3.3.3/', b)).toContain('3.3.3.3 is not in');
        expect(await slot('redir', 'http://2.2.2.2/redirect', b)).toContain('8.8.8.8 is not in');
        // Rebound: the old authority is gone for the next call.
        expect(await slot('rebound', 'http://2.2.2.2/', 'egress:provider=3.3.3.3')).toContain(
          '2.2.2.2 is not in',
        );
      }, 60_000);

      it('a private address only when the binding is marked private, never metadata', async () => {
        expect(await slot('pub', 'http://localhost/', 'egress:provider=localhost')).toContain(
          'private address blocked',
        );
        expect(await slot('priv', 'http://localhost/', 'egress:provider=localhost;private')).toBe(
          'bound-priv-[localhost]-200',
        );
        expect(
          await slot(
            'meta',
            'http://169.254.169.254/latest',
            'egress:provider=169.254.169.254;private',
          ),
        ).toContain('cloud-metadata');
        expect(seen.some((u) => u.includes('169.254'))).toBe(false);
        // A redirect from the private authority may not leave it, even for an approved one.
        expect(
          await slot('leave', 'http://localhost/to-public', 'egress:provider=localhost;private'),
        ).toContain('may not leave it');
      }, 60_000);
    });

    it('refuses a NAT64 address', async () => {
      expect(await net('nat64', 'http://[64:ff9b::a00:1]/')).toContain('private address blocked');
      expect(seen.some((u) => u.includes('64:ff9b'))).toBe(false);
    }, 40_000);
  });

  it("reads consent from god's row, not a firm's activation row written without it", async () => {
    const name = `${EXT}-firm`;
    try {
      await sql`INSERT INTO zv_extension_registry (name, display_name, is_installed)
                VALUES (${name}, ${name}, true)`.execute(db);
      await recordConsent(db, name, ['data:system']);
      await sql`INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_enabled)
                VALUES (${name}, ${name}, ${OTHER}, true)`.execute(db);
      // God's tuple now lies after the firm's: a read of "the first row" got NULL.
      await sql`UPDATE zv_extension_registry SET is_enabled = true
                WHERE name = ${name} AND tenant_id IS NULL`.execute(db);
      expect(await readGranted(db, name)).toEqual(['data:system']);
    } finally {
      await sql`DELETE FROM zv_extension_registry WHERE name = ${name}`.execute(db);
    }
  });

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
