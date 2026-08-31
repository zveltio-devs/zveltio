/**
 * How many database connections does one request need?
 *
 * The concurrency ceiling of an instance sits exactly at `DB_POOL_MAX`, and it
 * is not a slope: at `c = pool` the service stops, every connection
 * `idle in transaction` and one active. The plan blamed transaction LENGTH.
 * Measured, a warm list request holds its transaction for 1,59 ms, of which
 * 0,39 ms is before the first query and 0,05 ms after the last — there is
 * nothing at the edges to trim.
 *
 * The mechanism is a SECOND RESERVATION. A request holds one connection for its
 * tenant transaction and then asks the pool for another, so it needs two AT
 * ONCE. Below the ceiling some connection is always free to serve that second
 * ask; AT the ceiling every connection is held by a transaction whose owner is
 * waiting for one that can never come. That is why the collapse point is
 * `c = pool` and not `c = pool / 2`.
 *
 * ── Why this is a test and not a probe ────────────────────────
 *
 * The obvious check ran the engine with `DB_POOL_MAX=1` and called any route
 * that failed to answer guilty. It named ten. The same ten then answered 200,
 * at pool 1, against an engine started by hand — because between probes the
 * engine's own background writes hold the single connection, and a request
 * needing nothing but its transaction still times out waiting. It kept naming
 * routes after they were fixed, which is the worst thing a gate can do.
 *
 * So the property is counted where it happens: the pool driver counts every
 * acquisition made while a request already holds its transaction, and the
 * tenant middleware reports it in `x-zveltio-extra-connections`. Nothing here
 * depends on timing, saturation, or what the engine is doing in the background.
 *
 * A ratchet: `EXPECTED` lists what still asks for a second connection. It may
 * shrink — delete the entry when you fix one — and must never grow.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { _setConnectionTracing } from '../../db/connection-trace.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

/**
 * Routes that still take a connection beyond their transaction.
 *
 * Fixed on 2026-08-30, and left here as the shape of the fix rather than as
 * history: `isGodUser` (called by `checkPermission` on nearly every request)
 * read the pool on every miss, because its cache is Valkey and self-hosted
 * installs — the target deployment — mostly have none; the request log and the
 * god audit log issued their writes while the transaction was still open, where
 * being un-awaited does not help because the connection is taken the moment the
 * statement is issued; and `routes/webhooks.ts` queried the bare pool nine
 * times, which also meant its tenant scoping rested entirely on an explicit
 * `where tenant_id`.
 */
const EXPECTED: Record<string, number> = {};

const ROUTES = [
  '/api/me',
  '/api/webhooks',
  '/api/notifications',
  '/api/revisions',
  '/api/flows',
  '/api/settings',
  '/api/users',
  '/api/dashboards',
  '/api/saved-queries',
  '/api/api-keys',
  '/api/audit',
  '/api/tenants',
  '/api/invitations',
  '/api/storage/files',
  '/api/permissions/roles',
  '/api/admin/rls',
];

/** The hottest path of all, and the reason any of this matters. */
const DATA_COLLECTION = `secondres_${Date.now()}`;

d('a request needs one connection (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);

    // A real collection, so `/api/data/...` is measured on the path a caller
    // actually takes rather than on a 404 that returns before doing the work.
    await sql
      .raw(`
      CREATE TABLE zvd_${DATA_COLLECTION} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        title text
      )
    `)
      .execute(db);
    await sql`
      INSERT INTO zvd_collections (name, display_name) VALUES (${DATA_COLLECTION}, ${DATA_COLLECTION})
      ON CONFLICT DO NOTHING
    `
      .execute(db)
      .catch(() => {});
    _setConnectionTracing(true);
  });

  afterAll(async () => {
    _setConnectionTracing(false);
    await sql
      .raw(`DROP TABLE IF EXISTS zvd_${DATA_COLLECTION} CASCADE`)
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zvd_collections WHERE name = ${DATA_COLLECTION}`
      .execute(db)
      .catch(() => {});
  });

  for (const route of ROUTES) {
    it(`${route} takes nothing beyond its transaction`, async () => {
      const res = await app.request(route, { headers: { cookie } });
      // Any status is fine — this is not a test of what the route answers.
      expect(res.status).toBeGreaterThan(0);
      const extra = Number(res.headers.get('x-zveltio-extra-connections') ?? '0');
      expect(extra).toBeLessThanOrEqual(EXPECTED[route] ?? 0);
    });
  }

  it('/api/data/<collection> takes nothing beyond its transaction', async () => {
    // The hottest path, and the reason any of this matters. It gets its own case
    // rather than a line in the list: the list is walked when the suite is
    // DEFINED, so a route pushed from `beforeAll` is never tested — which is
    // exactly what the first version of this did, and it reported 17 green
    // without ever asking about the one route that carries the traffic.
    const res = await app.request(`/api/data/${DATA_COLLECTION}?limit=5`, {
      headers: { cookie },
    });
    expect(res.status).toBeGreaterThan(0);
    const extra = Number(res.headers.get('x-zveltio-extra-connections') ?? '0');
    // Say WHERE, not just how many. A count sends whoever reads this back
    // through CI to find the line; the site is already in hand.
    const { tracedAcquisitionSite } = await import('../../db/connection-trace.js');
    expect(`${extra} — ${tracedAcquisitionSite()}`).toBe('0 — ');
  });

  it('counts a second connection when one is genuinely taken', async () => {
    // The ratchet is only worth having if a violation would be seen. Planted:
    // a query issued on the pool while the request's transaction is open is
    // exactly what the counter is for, so provoke one and read it back.
    const { getDb } = await import('../../db/index.js');
    const { sql } = await import('kysely');
    const { beginTracedTransaction, endTracedTransaction } = await import(
      '../../db/connection-trace.js'
    );

    beginTracedTransaction();
    await sql`SELECT 1`.execute(getDb());
    expect(endTracedTransaction()).toBeGreaterThan(0);

    // And it counts nothing outside a traced window.
    await sql`SELECT 1`.execute(getDb());
    expect(endTracedTransaction()).toBe(0);
  });
});
