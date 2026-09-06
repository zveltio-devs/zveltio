/**
 * The total has to describe the list it comes with.
 *
 * `GET /api/admin/logs` filtered the rows and counted the whole table. Filter by
 * `status=500` on an instance with forty thousand logged requests and the
 * response said `total: 40000` beside three rows, so the caller paged through
 * empty pages looking for the rest. A total that does not describe its list is
 * worse than none: nothing tells the reader it is wrong.
 *
 * And the path filter went into a LIKE pattern unescaped, while `routes/users.ts`
 * escapes its own search with the helper that exists for it — so a `%` or `_`
 * typed into the box was a wildcard rather than a character.
 */
import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('GET /api/admin/logs filters (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  const tag = crypto.randomUUID().slice(0, 8);
  const literal = `/probe_${tag}/x`; // the underscore is the point
  const decoy = `/probeZ${tag}/x`; // matches only if `_` is a wildcard

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    for (const [p, status] of [
      [literal, 200],
      [decoy, 200],
      [`/other_${tag}`, 500],
    ] as const) {
      await sql`
        INSERT INTO zv_request_logs (method, path, status, duration_ms)
        VALUES ('GET', ${p}, ${status}, 1)
      `.execute(db);
    }
  });

  afterAll(async () => {
    await sql`DELETE FROM zv_request_logs WHERE path LIKE ${`%${tag}%`}`.execute(db);
  });

  async function get(qs: string) {
    const res = await app.request(`/api/admin/logs?${qs}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    return (await res.json()) as { logs: Array<{ path: string }>; total: number };
  }

  it('answers the unfiltered listing, which is the common call', async () => {
    // No query parameters at all. The filter expression is then `eb.and([])`,
    // and whether an empty conjunction is legal SQL is the LIBRARY's decision,
    // not this route's — Kysely special-cases it today. Pinned because nothing
    // else here exercises the default path: every other case in this file passes
    // a filter, so a dependency bump that stopped special-casing it would break
    // the most common request with the suite still green.
    const res = await app.request('/api/admin/logs?limit=5', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { logs: unknown[]; total: number };
    expect(Array.isArray(body.logs)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('counts what it returns, not the whole table', async () => {
    const body = await get(`path=${encodeURIComponent(tag)}&status=500&limit=100`);
    expect(body.logs.length).toBe(1);
    expect(body.total).toBe(1);
  });

  it('treats an underscore in the filter as a character, not a wildcard', async () => {
    const body = await get(`path=${encodeURIComponent(literal)}&limit=100`);
    expect(body.logs.map((l) => l.path)).toEqual([literal]);
    expect(body.total).toBe(1);
  });

  it('still filters and still paginates', async () => {
    // The obvious mistake in the other direction: a shared filter helper that
    // silently stops applying to one of the two queries.
    const body = await get(`path=${encodeURIComponent(tag)}&limit=100`);
    expect(body.logs.length).toBe(3);
    expect(body.total).toBe(3);
  });
});
