/**
 * Bulk and sync writes enqueue their webhook events with the write (ADR 0035,
 * slice 3).
 *
 * `POST|PATCH|DELETE /api/data/:collection/bulk` and `POST /api/sync/push`
 * swallowed `afterWrite` failures, the enqueue among them, so a batch whose
 * events could not be queued committed its rows and lost the events. Now the
 * batch's events go in as one `boss.insert` on the batch's transaction, and a
 * refused enqueue is the batch's failure: 503 `webhooks.enqueue_failed`, no row
 * written. The one-lookup-per-batch half is the unit test's
 * (`tests/unit/webhooks.test.ts`), which sees every statement.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { _setBossForTests } from '../../lib/data/ddl-queue.js';
import { DDLManager, type JobQueue, jobQueue } from '../../lib/data/index.js';
import { WEBHOOK_QUEUE, type WebhookJob } from '../../lib/webhooks.js';
import { DEFAULT_TENANT_ID } from '../../lib/route-db.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = `whbs_${Date.now()}`;
const C = `${STAMP}_c`;
const N = 5;

d('bulk and sync webhook events (ADR 0035 slice 3)', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  let hook = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: C,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
    const row = await sql<{ id: string }>`
      INSERT INTO zvd_webhooks (tenant_id, name, url, events, collections, retry_attempts)
      VALUES (${DEFAULT_TENANT_ID}::uuid, ${STAMP}, 'https://93.184.216.34/whbs',
              ARRAY['*']::text[], ARRAY[${C}]::text[], 1)
      RETURNING id::text AS id`.execute(db);
    hook = row.rows[0]!.id;
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM pgboss.job WHERE name = ${WEBHOOK_QUEUE} AND data->>'webhookId' = ${hook}`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zvd_webhooks WHERE id = ${hook}::uuid`.execute(db);
    await sql.raw(`DROP TABLE IF EXISTS "zvd_${C}" CASCADE`).execute(db);
    await sql`DELETE FROM zvd_collections WHERE name = ${C}`.execute(db);
  });

  const call = (method: string, path: string, body: unknown) =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify(body),
    });
  const bulk = (method: string, body: unknown) => call(method, `/api/data/${C}/bulk`, body);

  /** This webhook's jobs whose record title starts with `prefix`. */
  const jobsFor = async (prefix: string) =>
    (
      await sql<{ data: WebhookJob }>`
        SELECT data FROM pgboss.job
         WHERE name = ${WEBHOOK_QUEUE} AND data->>'webhookId' = ${hook}
           AND data->'data'->>'title' LIKE ${`${prefix}%`}`.execute(db)
    ).rows.map((r) => r.data);

  const titles = async (prefix: string) =>
    (
      await sql<{ title: string }>`
        SELECT title FROM ${sql.table(`zvd_${C}`)} WHERE title LIKE ${`${prefix}%`}
         ORDER BY title`.execute(db)
    ).rows.map((r) => r.title);

  /** Run `fn` with pg-boss replaced by `boss`; the real one is put back. */
  const withBoss = async <T>(boss: unknown, fn: () => T | Promise<T>): Promise<T> => {
    const real = jobQueue();
    _setBossForTests(boss);
    try {
      return await fn();
    } finally {
      _setBossForTests(real);
    }
  };
  const refusing = {
    createQueue: async () => undefined,
    insert: async () => {
      throw new Error('insert refused');
    },
  };

  /** A refused enqueue answers 503 webhooks.enqueue_failed, with no queue and with a failing INSERT. */
  const expectRefused = async (send: () => Response | Promise<Response>) => {
    for (const boss of [null, refusing]) {
      const res = await withBoss(boss, send);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { code?: string }).code).toBe('webhooks.enqueue_failed');
    }
  };

  const seed = async (prefix: string) => {
    const res = await bulk('POST', {
      records: Array.from({ length: N }, (_, i) => ({ title: `${prefix}-${i}` })),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { records: Array<{ id: string }> }).records.map((r) => r.id);
  };

  it(`a bulk create of ${N} rows enqueues ${N} jobs in one batch insert`, async () => {
    const real = jobQueue() as JobQueue;
    const batches: number[] = [];
    const spy = {
      createQueue: (...a: Parameters<JobQueue['createQueue']>) => real.createQueue(...a),
      insert: (...a: Parameters<JobQueue['insert']>) => {
        batches.push(a[1].length);
        return real.insert(...a);
      },
    };
    await withBoss(spy, () => seed('batch'));
    expect(batches).toEqual([N]);
    const jobs = await jobsFor('batch');
    expect(jobs).toHaveLength(N);
    // One event per row: its own id and sequence value.
    expect(new Set(jobs.map((j) => j.eventId)).size).toBe(N);
    expect(new Set(jobs.map((j) => j.sequence)).size).toBe(N);
  }, 30_000);

  it('a bulk create whose events cannot be enqueued is 503 and writes no row', async () => {
    await expectRefused(() =>
      bulk('POST', { records: Array.from({ length: N }, (_, i) => ({ title: `bc-${i}` })) }),
    );
    expect(await titles('bc-')).toEqual([]);
  }, 30_000);

  it('a bulk update whose events cannot be enqueued is 503 and changes no row', async () => {
    const ids = await seed('bu');
    await expectRefused(() =>
      bulk('PATCH', { records: ids.map((id) => ({ id, title: `bu-changed-${id}` })) }),
    );
    expect(await titles('bu-changed')).toEqual([]);
    expect(await titles('bu-')).toHaveLength(N);
  }, 30_000);

  it('a bulk delete whose events cannot be enqueued is 503 and deletes no row', async () => {
    const ids = await seed('bd');
    await expectRefused(() => bulk('DELETE', { ids }));
    expect(await titles('bd-')).toHaveLength(N);
  }, 30_000);

  it('a sync push whose events cannot be enqueued is 503 and writes no row', async () => {
    const [existing] = await seed('sp');
    await expectRefused(() =>
      call('POST', '/api/sync/push', {
        operations: [
          {
            collection: C,
            recordId: crypto.randomUUID(),
            operation: 'create',
            payload: { title: 'sp-new' },
          },
          {
            collection: C,
            recordId: existing,
            operation: 'update',
            payload: { title: 'sp-changed' },
          },
        ],
      }),
    );
    expect(await titles('sp-new')).toEqual([]);
    expect(await titles('sp-changed')).toEqual([]);
    // The control: with the queue running the same push lands, with its jobs.
    const ok = await call('POST', '/api/sync/push', {
      operations: [
        {
          collection: C,
          recordId: crypto.randomUUID(),
          operation: 'create',
          payload: { title: 'sp-ok' },
        },
      ],
    });
    expect(ok.status).toBe(200);
    expect(await titles('sp-ok')).toEqual(['sp-ok']);
    expect(await jobsFor('sp-ok')).toHaveLength(1);
  }, 30_000);
});
