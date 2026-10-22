/**
 * A handler that has already written refuses by THROWING, and keeps its answer.
 *
 * The tenant middleware commits a request whose handler returned, whatever the
 * status, and rolls back one whose handler threw. A handler (an extension's,
 * typically) that wrote and then learnt it must refuse — a data API answer after
 * its own write — had to throw to roll back, but `problemOnError` rendered every
 * HTTPException as a generic envelope, dropping the response it carried. So the
 * refusal lost its status and body unless the extension mounted its own onError
 * (zveltio-extensions#239). Hono's default handler answers `err.res`; so does
 * `problemOnError` now.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { problemOnError } from '../../lib/problem.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TABLE = `harness_refusal_${Date.now()}`;

d('a thrown refusal rolls the request back and keeps its answer', () => {
  let db: Database;
  const probe = new Hono();

  const write = (c: Context, tag: string) =>
    sql`INSERT INTO ${sql.table(TABLE)} (tag) VALUES (${tag})`.execute(
      c.get('tenantTrx') as Database,
    );
  const tags = async () =>
    (
      await sql<{ tag: string }>`SELECT tag FROM ${sql.table(TABLE)} ORDER BY tag`.execute(db)
    ).rows.map((r) => r.tag);

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql.raw(`CREATE TABLE ${TABLE} (tag text)`).execute(db);
    await sql.raw(`GRANT SELECT, INSERT ON ${TABLE} TO zveltio_rls`).execute(db);
    probe.use('*', tenantMiddleware);
    probe.onError(problemOnError);
    probe.post('/api/probe/res', async (c) => {
      await write(c, 'res');
      throw new HTTPException(409, { res: c.json({ refused: 'by the data API' }, 409) });
    });
    probe.post('/api/probe/plain', async (c) => {
      await write(c, 'plain');
      throw new HTTPException(422, { message: 'no' });
    });
    probe.post('/api/probe/returned', async (c) => {
      await write(c, 'returned');
      return c.json({ refused: true }, 403);
    });
  });

  afterAll(async () => {
    await sql.raw(`DROP TABLE IF EXISTS ${TABLE}`).execute(db);
  });

  it('answers with the response the exception carries, and keeps nothing', async () => {
    const res = await probe.request('/api/probe/res', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ refused: 'by the data API' });
    expect(await tags()).not.toContain('res');
  });

  it('without one, the problem envelope, and still keeps nothing', async () => {
    const res = await probe.request('/api/probe/plain', { method: 'POST' });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { detail: string }).detail).toBe('no');
    expect(await tags()).not.toContain('plain');
  });

  // Deliberately unchanged: a handler may write before refusing (an attempt counter).
  it('a returned refusal still commits', async () => {
    const res = await probe.request('/api/probe/returned', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(await tags()).toContain('returned');
  });
});
