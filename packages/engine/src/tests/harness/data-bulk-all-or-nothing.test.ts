/**
 * ADR 0044 — a bulk data write is all or nothing.
 *
 * Before it, a row the engine refused (validation, a hook, a missing record) was
 * listed with 207 and the other rows were committed, with their revisions and
 * webhook jobs. Now one refused row refuses the batch: 422 `bulk_refused`
 * naming every refused row, and nothing of the batch is stored.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { engineEvents } from '../../lib/runtime/event-bus.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hbulkaon_${Date.now()}`;
const MISSING = '00000000-0000-4000-8000-0000000000aa';

type Refused = { code: string; errors: { index: number; id?: string; errors: string[] }[] };

d('bulk write is all or nothing (ADR 0044, in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let webhookId = '';
  const emitted: string[] = [];
  let unsubs: (() => void)[] = [];

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'label', type: 'text', required: true, unique: false, indexed: false },
        { name: 'score', type: 'number', required: false, unique: false, indexed: false },
      ],
    } as never);
    const wh = await call('POST', '/api/webhooks', {
      name: `Harness bulk aon ${Date.now()}`,
      url: 'https://example.test/hook-aon',
      events: ['*'],
      collections: [COLLECTION],
    });
    const body = (await wh.json()) as { id?: string; webhook?: { id: string } };
    webhookId = body.id ?? body.webhook!.id;
    unsubs = (['record.created', 'record.updated', 'record.deleted'] as const).map((e) =>
      engineEvents.on(e, (p) => {
        if (p.collection === COLLECTION) emitted.push(e);
      }),
    );
  });

  afterEach(() => engineEvents.clearPreHooks());

  afterAll(async () => {
    for (const u of unsubs) u();
    if (!db) return;
    await sql`DELETE FROM pgboss.job WHERE data->>'webhookId' = ${webhookId}`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zvd_webhooks WHERE id = ${webhookId}::uuid`.execute(db).catch(() => {});
    await sql`DELETE FROM zv_revisions WHERE collection = ${COLLECTION}`
      .execute(db)
      .catch(() => {});
    await sql.raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`).execute(db);
    await db.deleteFrom('zvd_collections').where('name', '=', COLLECTION).execute();
  });

  function call(method: string, path: string, body: unknown) {
    return app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
  }
  const bulk = (method: string, body: unknown) =>
    call(method, `/api/data/${COLLECTION}/bulk`, body);

  /** Rows, revisions, webhook jobs and record events the collection has so far. */
  async function footprint() {
    const n = async (q: ReturnType<typeof sql<{ n: string }>>) =>
      Number((await q.execute(db)).rows[0]!.n);
    return {
      rows: await n(
        sql<{ n: string }>`SELECT count(*)::text AS n FROM ${sql.table(`zvd_${COLLECTION}`)}`,
      ),
      labels: (
        await sql<{ label: string; score: number | null }>`SELECT label, score FROM ${sql.table(
          `zvd_${COLLECTION}`,
        )} ORDER BY label`.execute(db)
      ).rows,
      revisions: await n(
        sql<{
          n: string;
        }>`SELECT count(*)::text AS n FROM zv_revisions WHERE collection = ${COLLECTION}`,
      ),
      jobs: await n(
        sql<{
          n: string;
        }>`SELECT count(*)::text AS n FROM pgboss.job WHERE data->>'webhookId' = ${webhookId}`,
      ),
      events: emitted.length,
    };
  }

  let ids: string[] = [];

  it('POST: all valid rows are stored, with revisions, jobs and events', async () => {
    const before = await footprint();
    const res = await bulk('POST', { records: [{ label: 'a', score: 1 }, { label: 'b' }] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { created: number; records: { id: string }[] };
    expect(body.created).toBe(2);
    ids = body.records.map((r) => r.id);
    const after = await footprint();
    expect(after.rows).toBe(before.rows + 2);
    expect(after.revisions).toBe(before.revisions + 2);
    expect(after.jobs).toBe(before.jobs + 2);
    expect(after.events).toBe(before.events + 2);
  });

  it('POST: refused rows among valid ones refuse the batch and name every refused row', async () => {
    engineEvents.onBefore('record.beforeInsert', (p) => {
      if (p.data.label === 'blocked') p.abort('quota');
    });
    const before = await footprint();
    const res = await bulk('POST', {
      records: [{ label: 'c' }, { score: 2 }, { label: 'd' }, { label: 'blocked' }, { label: 'e' }],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Refused;
    expect(body.code).toBe('bulk_refused');
    expect(body.errors.map((e) => e.index)).toEqual([1, 3]);
    expect(body.errors[1]!.errors.join()).toContain('EXT_HOOK_ABORTED: quota');
    expect(await footprint()).toEqual(before);
  });

  it('PATCH: refused rows among valid ones refuse the batch and name every refused row', async () => {
    engineEvents.onBefore('record.beforeUpdate', (p) => {
      if (p.id === ids[1]) p.abort('frozen');
    });
    const before = await footprint();
    const res = await bulk('PATCH', {
      records: [
        { id: ids[0], score: 10 },
        { id: MISSING, score: 11 },
        { id: ids[1], score: 12 },
        { id: ids[0], label: null },
      ],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Refused;
    expect(body.code).toBe('bulk_refused');
    expect(body.errors.map((e) => [e.index, e.id])).toEqual([
      [1, MISSING],
      [2, ids[1]],
      [3, ids[0]],
    ]);
    expect(body.errors[0]!.errors).toEqual(['Record not found']);
    expect(await footprint()).toEqual(before);
  });

  it('PATCH: all valid rows are stored', async () => {
    const before = await footprint();
    const res = await bulk('PATCH', {
      records: [
        { id: ids[0], score: 10 },
        { id: ids[1], score: 12 },
      ],
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { updated: number }).updated).toBe(2);
    const after = await footprint();
    // `number` is a numeric column: it reads back as a string.
    expect(after.labels.map((r) => [r.label, Number(r.score)])).toEqual([
      ['a', 10],
      ['b', 12],
    ]);
    expect(after.revisions).toBe(before.revisions + 2);
    expect(after.jobs).toBe(before.jobs + 2);
  });

  it('DELETE: refused ids among valid ones refuse the batch and name every refused id', async () => {
    engineEvents.onBefore('record.beforeDelete', (p) => {
      if (p.id === ids[1]) p.abort('protected');
    });
    const before = await footprint();
    const res = await bulk('DELETE', { ids: [ids[0], MISSING, ids[1]] });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Refused;
    expect(body.code).toBe('bulk_refused');
    expect(body.errors).toEqual([
      { index: 1, id: MISSING, errors: ['Record not found'] },
      { index: 2, id: ids[1]!, errors: ['EXT_HOOK_ABORTED: protected'] },
    ]);
    expect(await footprint()).toEqual(before);
  });

  it('DELETE: all valid ids are deleted', async () => {
    const before = await footprint();
    const res = await bulk('DELETE', { ids });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { deleted: number }).deleted).toBe(2);
    const after = await footprint();
    expect(after.rows).toBe(0);
    expect(after.revisions).toBe(before.revisions + 2);
    expect(after.jobs).toBe(before.jobs + 2);
  });
});
