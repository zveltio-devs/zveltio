/**
 * A handler that THROWS inside the request transaction rolls that transaction
 * back.
 *
 * Hono's `onError` turns the throw into a response inside `next()`, so the
 * tenant middleware saw `next()` resolve and committed: the client got 500 and
 * every row written before the throw was kept, with its after-commit work
 * (webhooks, flows) run for it.
 *
 * The request log is the counterweight: it records failures by design, so the
 * rollback must not take the log row with it.
 *
 * Mounted on the real `tenantMiddleware`, `problemOnError` and
 * `requestLogMiddleware` against the harness database — no engine route writes
 * and then throws on purpose, which is the point of the fix.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { problem, problemOnError } from '../../lib/problem.js';
import { onAfterCommit } from '../../lib/tenancy/index.js';
import { requestLogMiddleware } from '../../middleware/request-log.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hthrow_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;
const BASE = `/api/${COLLECTION}`;

d('a handler that throws rolls the request transaction back', () => {
  let db: Database;
  let app: Hono;
  const afterCommitRan: string[] = [];

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);

    app = new Hono();
    app.onError(problemOnError);
    app.use('/api/*', tenantMiddleware);
    app.use('/api/*', requestLogMiddleware(db));
    const write = async (trx: Database | null, title: string) => {
      await sql`INSERT INTO ${sql.table(TABLE)} (title) VALUES (${title})`.execute(trx!);
      onAfterCommit(() => {
        afterCommitRan.push(title);
      });
    };
    app.post(`${BASE}/throw`, async (c) => {
      await write(c.get('tenantTrx'), 'thrown');
      throw new Error('handler failed after writing');
    });
    app.post(`${BASE}/conflict`, async (c) => {
      await write(c.get('tenantTrx'), 'refused');
      throw problem('test.conflict', 409, 'refused after writing');
    });
    app.post(`${BASE}/ok`, async (c) => {
      await write(c.get('tenantTrx'), 'kept');
      return c.json({ ok: true }, 201);
    });
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await sql.raw(`DROP TABLE IF EXISTS "${TABLE}" CASCADE`).execute(db);
    await sql`DELETE FROM zvd_collections WHERE name = ${COLLECTION}`.execute(db);
    await sql`DELETE FROM zv_request_logs WHERE path LIKE ${`${BASE}/%`}`.execute(db);
  });

  const titles = async () =>
    (
      await sql<{ title: string }>`SELECT title FROM ${sql.table(TABLE)} ORDER BY title`.execute(db)
    ).rows.map((r) => r.title);

  const loggedStatus = async (path: string) => {
    for (let i = 0; i < 40; i++) {
      const row = (
        await sql<{ status: number }>`
          SELECT status FROM zv_request_logs WHERE path = ${path}`.execute(db)
      ).rows[0];
      if (row) return row.status;
      await Bun.sleep(50);
    }
    return undefined;
  };

  it('a non-HTTP throw answers 500 and keeps nothing it wrote', async () => {
    const res = await app.request(`${BASE}/throw`, { method: 'POST' });
    expect(res.status).toBe(500);
    // onError's envelope, not the commit-failure message.
    const body = (await res.json()) as { status?: number; code?: string };
    expect(body.status).toBe(500);
    expect(await titles()).not.toContain('thrown');
    expect(afterCommitRan).not.toContain('thrown');
    // The failure is still recorded.
    expect(await loggedStatus(`${BASE}/throw`)).toBe(500);
  }, 30_000);

  it('a thrown 4xx keeps its status and rolls back too', async () => {
    const res = await app.request(`${BASE}/conflict`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('test.conflict');
    expect(await titles()).not.toContain('refused');
    expect(afterCommitRan).not.toContain('refused');
    expect(await loggedStatus(`${BASE}/conflict`)).toBe(409);
  }, 30_000);

  it('a handler that answers normally still commits', async () => {
    const res = await app.request(`${BASE}/ok`, { method: 'POST' });
    expect(res.status).toBe(201);
    expect(await titles()).toContain('kept');
    for (let i = 0; i < 40 && !afterCommitRan.includes('kept'); i++) await Bun.sleep(25);
    expect(afterCommitRan).toContain('kept');
    expect(await loggedStatus(`${BASE}/ok`)).toBe(201);
  }, 30_000);
});
