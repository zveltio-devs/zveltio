/**
 * A webhook event is a pg-boss job enqueued with the write (ADR 0035, slice 1).
 *
 * The job row commits with the record or not at all, so an event survives a
 * process that dies right after COMMIT; a write whose event cannot be queued is
 * refused; delivery is at least once, carries `id` and `sequence`, and its
 * retries and dead letters are pg-boss's and the delivery row's.
 *
 * The harness starts pg-boss but no webhook worker, so each test runs the due
 * jobs itself (`_runWebhookJobs`), as a freshly started worker would.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { _setBossForTests } from '../../lib/data/ddl-queue.js';
import { afterWrite, DDLManager, jobQueue, maybeEncrypt } from '../../lib/data/index.js';
import { currentAfterCommitQueue, withTenantIsolation } from '../../lib/tenancy/index.js';
import {
  _setReadAsRoleForTests,
  runWebhookJob,
  WEBHOOK_QUEUE,
  type WebhookJob,
} from '../../lib/webhooks.js';
import { DEFAULT_TENANT_ID } from '../../lib/route-db.js';
import { asEngineRole } from '../../lib/role-window.js';
import {
  createGodSession,
  drainWebhookJobs,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = `whpb_${Date.now()}`;
const C = `${STAMP}_c`;
const QUIET = `${STAMP}_quiet`;
const SECRET = `whpb-secret-${STAMP}`;

type Job = { id: string; state: string; data: WebhookJob };

d('webhooks on pg-boss (ADR 0035)', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  let hook = '';
  let originalFetch: typeof fetch;
  let answer = 200;
  /** Envelopes POSTed for this file's collection. */
  const sent: Array<{ id: string; sequence: number; event: string; data: { title?: string } }> = [];
  /** The raw body and signature header of each POST, in order. */
  const signed: Array<{ body: string; signature: string }> = [];

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    for (const name of [C, QUIET]) {
      await DDLManager.createCollection(db, {
        name,
        fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
      } as never);
    }
    const row = await sql<{ id: string }>`
      INSERT INTO zvd_webhooks (tenant_id, name, url, events, collections, retry_attempts, secret)
      VALUES (${DEFAULT_TENANT_ID}::uuid, ${STAMP}, 'https://93.184.216.34/whpb',
              ARRAY['*']::text[], ARRAY[${C}]::text[], 1, ${await maybeEncrypt(SECRET, true)})
      RETURNING id::text AS id`.execute(db);
    hook = row.rows[0]!.id;

    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      if (body.includes(C)) {
        sent.push(JSON.parse(body));
        signed.push({
          body,
          signature: new Headers(init?.headers).get('x-zveltio-signature') ?? '',
        });
      }
      return { status: answer, ok: answer < 400, text: async () => 'x' } as Response;
    }) as unknown as typeof fetch;
  }, 60_000);

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    if (!db) return;
    await sql`DELETE FROM pgboss.job WHERE name = ${WEBHOOK_QUEUE} AND data->>'webhookId' = ${hook}`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zvd_webhook_deliveries WHERE webhook_id = ${hook}::uuid`.execute(db);
    await sql`DELETE FROM zvd_webhooks WHERE id = ${hook}::uuid`.execute(db);
    for (const name of [C, QUIET]) {
      await sql.raw(`DROP TABLE IF EXISTS "zvd_${name}" CASCADE`).execute(db);
      await sql`DELETE FROM zvd_collections WHERE name = ${name}`.execute(db);
    }
  });

  const post = (collection: string, title: string) =>
    app.request(`/api/data/${collection}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({ title }),
    });

  /** This webhook's jobs whose record has `title`, oldest first. */
  const jobsFor = async (title: string): Promise<Job[]> =>
    (
      await sql<Job>`
        SELECT id::text AS id, state::text AS state, data FROM pgboss.job
         WHERE name = ${WEBHOOK_QUEUE} AND data->>'webhookId' = ${hook}
           AND data->'data'->>'title' = ${title}
         ORDER BY created_on, (data->>'sequence')::bigint`.execute(db)
    ).rows;

  const deliveriesOf = async (eventId: string) =>
    (
      await sql<{
        attempt: number;
        max_attempts: number;
        delivered: boolean;
        status: number | null;
      }>`
        SELECT attempt, max_attempts, delivered_at IS NOT NULL AS delivered, status
          FROM zvd_webhook_deliveries
         WHERE webhook_id = ${hook}::uuid AND event_id = ${eventId}::uuid`.execute(db)
    ).rows;

  const drain = () => drainWebhookJobs(db);

  const count = async (title: string) =>
    (
      await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM ${sql.table(`zvd_${C}`)} WHERE title = ${title}`.execute(db)
    ).rows[0]!.n;

  const dlq = async (eventId: string) => {
    const res = await app.request('/api/webhooks/dlq?limit=500', { headers: { cookie: god } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{ eventId: string; sequence: number; data: unknown; error: string | null }>;
    };
    return body.entries.filter((e) => e.eventId === eventId);
  };

  const replay = () =>
    app.request('/api/webhooks/dlq/replay', { method: 'POST', headers: { cookie: god } });

  const asRun = (j: Job) => ({ id: j.id, data: j.data, retryCount: 0, retryLimit: 1 });

  it('(a) a write whose transaction rolls back leaves no job row', async () => {
    await withTenantIsolation(DEFAULT_TENANT_ID, async (trx) => {
      const row = await sql<Record<string, unknown> & { id: string }>`
        INSERT INTO ${sql.table(`zvd_${C}`)} (title) VALUES ('rolled') RETURNING *`.execute(trx);
      const rec = row.rows[0]!;
      await afterWrite(trx, {
        collection: C,
        recordId: rec.id,
        action: 'create',
        data: rec,
        userId: 'test',
        author: null,
        tenantId: DEFAULT_TENANT_ID,
      });
      // Queued inside: the absence below is the rollback's doing, not a no-op.
      expect(await jobsFor('rolled').then((j) => j.length)).toBe(0); // other connection
      // As the engine's role: the request role holds nothing on `pgboss`.
      const inside = await asEngineRole(trx, () =>
        sql<{ n: number }>`
          SELECT count(*)::int AS n FROM pgboss.job
           WHERE name = ${WEBHOOK_QUEUE} AND data->'data'->>'title' = 'rolled'`.execute(trx),
      );
      expect(inside.rows[0]!.n).toBe(1);
      throw new Error('roll back');
    }).catch((err: Error) => expect(err.message).toBe('roll back'));
    expect(await jobsFor('rolled')).toEqual([]);
  }, 30_000);

  it('(b) LV-06: a committed event whose after-commit work never ran is delivered by a later worker', async () => {
    await withTenantIsolation(DEFAULT_TENANT_ID, async (trx) => {
      const row = await sql<Record<string, unknown> & { id: string }>`
        INSERT INTO ${sql.table(`zvd_${C}`)} (title) VALUES ('crashed') RETURNING *`.execute(trx);
      const rec = row.rows[0]!;
      await afterWrite(trx, {
        collection: C,
        recordId: rec.id,
        action: 'create',
        data: rec,
        userId: 'test',
        author: null,
        tenantId: DEFAULT_TENANT_ID,
      });
      // The process dies after COMMIT: nothing queued in memory ever runs.
      currentAfterCommitQueue()!.jobs.length = 0;
    });
    const [job] = await jobsFor('crashed');
    expect(job?.state).toBe('created');
    expect(sent.filter((s) => s.data.title === 'crashed')).toEqual([]);

    await drain();
    const got = sent.filter((s) => s.data.title === 'crashed');
    expect(got).toHaveLength(1);
    expect(got[0]!.id).toBe(job!.data.eventId);
    // Signed with the secret read from the row at delivery; the job never held it.
    const last = signed.at(-1)!;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(last.body)),
    );
    expect(last.signature).toBe(`sha256=${Buffer.from(mac).toString('hex')}`);
    expect(JSON.stringify(job)).not.toContain(SECRET);
    expect(await deliveriesOf(job!.data.eventId)).toEqual([
      { attempt: 1, max_attempts: 1, delivered: true, status: 200 },
    ]);
  }, 30_000);

  it('(c) a failing endpoint is retried retry_attempts times, listed in /dlq, and replayed', async () => {
    answer = 500;
    expect((await post(C, 'failing')).status).toBe(201);
    await drain();
    const [job] = await jobsFor('failing');
    expect(job?.state).toBe('failed');
    const eventId = job!.data.eventId;
    // One attempt and `retry_attempts` (1) retries.
    expect(sent.filter((s) => s.id === eventId)).toHaveLength(2);
    expect(await deliveriesOf(eventId)).toEqual([
      { attempt: 2, max_attempts: 1, delivered: false, status: 500 },
    ]);

    const listed = () => dlq(eventId);
    const entries = await listed();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.sequence).toBe(job!.data.sequence);

    answer = 200;
    expect((await replay()).status).toBe(200);
    expect(await listed()).toEqual([]);
    await drain();
    const after = sent.filter((s) => s.id === eventId);
    expect(after).toHaveLength(3);
    expect(after[2]!.sequence).toBe(job!.data.sequence);
    expect(await deliveriesOf(eventId)).toEqual([
      { attempt: 1, max_attempts: 1, delivered: true, status: 200 },
    ]);
  }, 30_000);

  it('(d) the same job run twice writes one delivery row', async () => {
    answer = 500;
    expect((await post(C, 'twice-failing')).status).toBe(201);
    const [failing] = await jobsFor('twice-failing');
    await expect(runWebhookJob(asRun(failing!))).rejects.toThrow('delivery failed');
    await expect(runWebhookJob(asRun(failing!))).rejects.toThrow('delivery failed');
    expect(await deliveriesOf(failing!.data.eventId)).toHaveLength(1);

    answer = 200;
    expect((await post(C, 'twice-ok')).status).toBe(201);
    const [ok] = await jobsFor('twice-ok');
    await runWebhookJob(asRun(ok!));
    await runWebhookJob(asRun(ok!));
    expect(await deliveriesOf(ok!.data.eventId)).toHaveLength(1);
    // Delivered once: the second run finds the delivered row and stops.
    expect(sent.filter((s) => s.id === ok!.data.eventId)).toHaveLength(1);
    await sql`DELETE FROM pgboss.job WHERE id IN (${failing!.id}::uuid, ${ok!.id}::uuid)`.execute(
      db,
    );
  }, 30_000);

  it('(e) two updates of one record carry increasing sequence values', async () => {
    answer = 200;
    const created = await post(C, 'seq-0');
    const { id } = (await created.json()) as { id: string };
    for (const title of ['seq-1', 'seq-2']) {
      const res = await app.request(`/api/data/${C}/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', cookie: god },
        body: JSON.stringify({ title }),
      });
      expect(res.status).toBe(200);
    }
    const [first] = await jobsFor('seq-1');
    const [second] = await jobsFor('seq-2');
    expect(first!.data.event).toBe('update');
    expect(second!.data.sequence).toBeGreaterThan(first!.data.sequence);
    expect(second!.data.eventId).not.toBe(first!.data.eventId);
    await drain();
    const got = sent.filter((s) => s.data.title === 'seq-1' || s.data.title === 'seq-2');
    expect(got.map((s) => s.sequence).sort()).toEqual(
      [first!.data.sequence, second!.data.sequence].sort(),
    );
  }, 30_000);

  it('(f) with no job queue, or a refused job INSERT, a matching write is 503 and leaves no row', async () => {
    const real = jobQueue();
    _setBossForTests(null);
    try {
      const res = await post(C, 'no-queue');
      expect(res.status).toBe(503);
      expect(((await res.json()) as { code?: string }).code ?? '').toContain('webhooks');
    } finally {
      _setBossForTests(real);
    }
    expect(await count('no-queue')).toBe(0);

    _setBossForTests({
      createQueue: async () => undefined,
      insert: async () => {
        throw new Error('insert refused');
      },
    });
    try {
      expect((await post(C, 'insert-fails')).status).toBe(503);
    } finally {
      _setBossForTests(real);
    }
    expect(await count('insert-fails')).toBe(0);

    // With no subscriber, the same missing queue costs the write nothing.
    _setBossForTests(null);
    try {
      expect((await post(QUIET, 'no-queue-no-hook')).status).toBe(201);
    } finally {
      _setBossForTests(real);
    }
  }, 30_000);

  it('(g) a write to a collection with no subscriber inserts nothing into pgboss.job', async () => {
    const since = await sql<{ t: string }>`SELECT now()::text AS t`.execute(db);
    const newJobs = async (collection: string) =>
      (
        await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM pgboss.job
           WHERE created_on >= ${since.rows[0]!.t}::timestamptz
             AND data::text LIKE ${`%${collection}%`}`.execute(db)
      ).rows[0]!.n;
    expect((await post(QUIET, 'quiet')).status).toBe(201);
    expect(await newJobs(QUIET)).toBe(0);
    // The control: the same write with a subscriber does queue.
    expect((await post(C, 'loud')).status).toBe(201);
    expect(await newJobs(C)).toBe(1);
    await drain();
  }, 30_000);

  it('(h) a job that throws before its POST still records the attempt, listed in /dlq once exhausted', async () => {
    const restore = _setReadAsRoleForTests(async () => {
      throw new Error('role lookup down');
    });
    try {
      expect((await post(C, 'throws-early')).status).toBe(201);
      await drain();
    } finally {
      restore();
    }
    const [job] = await jobsFor('throws-early');
    expect(job?.state).toBe('failed');
    expect(await deliveriesOf(job!.data.eventId)).toEqual([
      { attempt: 2, max_attempts: 1, delivered: false, status: null },
    ]);
    const [entry] = await dlq(job!.data.eventId);
    expect(entry?.error).toContain('role lookup down');
    // No role's view of the record was ever taken, so there is nothing to send
    // again: a replay leaves it listed rather than deliver an empty event.
    expect(entry?.data).toBeNull();
    expect((await replay()).status).toBe(200);
    expect(await dlq(job!.data.eventId)).toHaveLength(1);
  }, 30_000);

  it('(i) a delivered POST whose delivery row cannot be written completes its job', async () => {
    answer = 200;
    expect((await post(C, 'row-write-fails')).status).toBe(201);
    const [job] = await jobsFor('row-write-fails');
    const fn = `whpb_refuse_${Date.now()}`;
    await sql
      .raw(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              IF NEW.payload->'data'->>'title' = 'row-write-fails' THEN
                RAISE EXCEPTION 'delivery row refused';
              END IF;
              RETURN NEW;
            END $$;
            CREATE TRIGGER ${fn} BEFORE INSERT OR UPDATE ON zvd_webhook_deliveries
              FOR EACH ROW EXECUTE FUNCTION ${fn}()`)
      .execute(db);
    try {
      // A throw here would have pg-boss POST the delivered event again.
      await runWebhookJob(asRun(job!));
    } finally {
      await sql.raw(`DROP TRIGGER ${fn} ON zvd_webhook_deliveries`).execute(db);
      await sql.raw(`DROP FUNCTION ${fn}()`).execute(db);
    }
    expect(sent.filter((s) => s.id === job!.data.eventId)).toHaveLength(1);
    await sql`DELETE FROM pgboss.job WHERE id = ${job!.id}::uuid`.execute(db);
  }, 30_000);

  it('(j) two replays at once queue one job per dead letter', async () => {
    answer = 500;
    expect((await post(C, 'raced')).status).toBe(201);
    await drain();
    const [failed] = await jobsFor('raced');
    expect(await dlq(failed!.data.eventId)).toHaveLength(1);
    answer = 200;
    const answers = await Promise.all([replay(), replay(), replay()]);
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200]);
    const queued = (await jobsFor('raced')).filter((j) => j.state === 'created');
    expect(queued).toHaveLength(1);
    await drain();
    expect(sent.filter((s) => s.id === failed!.data.eventId && s.data.title)).toHaveLength(3);
  }, 30_000);

  it('(k) webhook_queue_pending counts the delivery jobs waiting to run', async () => {
    const before = process.env.METRICS_TOKEN;
    process.env.METRICS_TOKEN = `whpb-metrics-${STAMP}`;
    const pending = async () => {
      const res = await app.request('/metrics', {
        headers: { Authorization: `Bearer ${process.env.METRICS_TOKEN}` },
      });
      expect(res.status).toBe(200);
      const line = /^webhook_queue_pending (\d+)$/m.exec(await res.text());
      return Number(line?.[1]);
    };
    try {
      answer = 200;
      await drain();
      const idle = await pending();
      expect((await post(C, 'pending-1')).status).toBe(201);
      expect((await post(C, 'pending-2')).status).toBe(201);
      expect(await pending()).toBe(idle + 2);
      await drain();
      expect(await pending()).toBe(idle);
    } finally {
      if (before === undefined) delete process.env.METRICS_TOKEN;
      else process.env.METRICS_TOKEN = before;
    }
  }, 30_000);
});
