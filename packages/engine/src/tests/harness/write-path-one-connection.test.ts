/**
 * A data write needs one connection, cold caches included.
 *
 * The validation engine read its rules on the bare pool from inside the
 * request transaction: the `to_regclass` probe for the rule-groups table once
 * per process, and the rules and groups on every 60 s cache miss. So the first
 * burst of writes after a boot (or a cache expiry) needed two connections per
 * request, and at `c = DB_POOL_MAX` every connection was held by a transaction
 * waiting for a second one: the writes stalled until the 35 s acquire deadline
 * and answered 503. The realtime bus's `pg_notify` was a second connection on
 * every write too, warm or cold. `second-reservation.test.ts` never saw either:
 * its collection has no fields, so the write returns before validation runs.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { _setConnectionTracing, tracedAcquisitionSite } from '../../db/connection-trace.js';
import { _settleAuditWrites } from '../../lib/audit.js';
import { DDLManager } from '../../lib/data/index.js';
import { invalidateRulesCache, resetRuleGroupsTableProbe } from '../../lib/validation-engine.js';
import {
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const C = `onecon_${Date.now()}`;

d('a data write needs one connection (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  // The connection trace counts process-wide, so an audit row the previous
  // request left in flight (it writes on the pool, after that request let go of
  // its connection) landed in this request's window: 'bulk PATCH 200 1' at
  // writeAuditRow, seen once in CI. Settled first, each window is its own.
  const cold = async () => {
    await _settleAuditWrites();
    resetRuleGroupsTableProbe(db);
    invalidateRulesCache(C);
  };
  const send = (method: string, path: string, body?: unknown) =>
    app.request(`/api/data/${C}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: C,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
  });

  // Long enough to outlast the 35 s acquire deadline a red run leaves behind.
  afterAll(async () => {
    _setConnectionTracing(false);
    if (db) await dropTestCollection(db, C);
  }, 60_000);

  it('every write verb, and a sync pull, takes nothing beyond its transaction', async () => {
    _setConnectionTracing(true);
    const seen: string[] = [];
    const call = async (label: string, method: string, path: string, body?: unknown) => {
      await cold();
      const res = await send(method, path, body);
      const extra = res.headers.get('x-zveltio-extra-connections') ?? '0';
      seen.push(
        `${label} ${res.status} ${extra}${extra === '0' ? '' : ` — ${tracedAcquisitionSite()}`}`,
      );
      return res;
    };
    const created = (await (await call('POST', 'POST', '', { title: 'a' })).json()) as {
      id: string;
    };
    await call('PATCH', 'PATCH', `/${created.id}`, { title: 'b' });
    await call('PUT', 'PUT', `/${created.id}`, { title: 'c' });
    await call('bulk POST', 'POST', '/bulk', { records: [{ title: 'd' }, { title: 'e' }] });
    await call('bulk PATCH', 'PATCH', '/bulk', { records: [{ id: created.id, title: 'f' }] });
    await call('DELETE', 'DELETE', `/${created.id}`);
    await cold();
    const pull = await app.request('/api/sync/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ collections: [C] }),
    });
    const pulled = pull.headers.get('x-zveltio-extra-connections') ?? '0';
    seen.push(
      `sync pull ${pull.status} ${pulled}${pulled === '0' ? '' : ` — ${tracedAcquisitionSite()}`}`,
    );
    _setConnectionTracing(false);
    expect(seen).toEqual([
      'POST 201 0',
      'PATCH 200 0',
      'PUT 200 0',
      'bulk POST 201 0',
      'bulk PATCH 200 0',
      'DELETE 200 0',
      'sync pull 200 0',
    ]);
  });

  it('a cold burst of writes at twice the pool size completes', async () => {
    // Red before the fix: every connection held by a transaction waiting for
    // the validation probe's second one, until the 35 s acquire deadline.
    const pool = Number(process.env.DB_POOL_MAX ?? '10');
    await cold();
    const statuses = await Promise.race([
      Promise.all(
        Array.from({ length: pool * 2 }, (_, n) =>
          Promise.resolve(send('POST', '', { title: `burst ${n}` })).then((r) => r.status),
        ),
      ),
      Bun.sleep(15_000).then(() => 'HANG'),
    ]);
    expect(statuses).toEqual(Array.from({ length: pool * 2 }, () => 201));
  }, 60_000);
});
