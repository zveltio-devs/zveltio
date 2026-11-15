/**
 * DR-40: a request whose in-process memos lapse while it holds its tenant
 * transaction must still need only that one connection.
 *
 * LV-20 measured lists at 500 clients collapse to ~30 rps with a third of them
 * refused `503 pool_busy`, while Postgres showed the whole pool `idle in
 * transaction` and the engine idled. The cause was `isGodUser`: its in-process
 * memo lives five seconds, `sessionPrefetch` primes it before the transaction
 * opens, and a request that queued for longer than that asked the pool again —
 * after `BEGIN` (the reach), in the access check, the read scope, the membership
 * gate and the god audit — while holding its own connection. An API key's
 * issuer email (`issuerEmail`, the same five seconds) did the same on key
 * requests. Once every pooled
 * connection was held by such a request, none of them could get the second, and
 * each waited out the 35 s acquire timeout.
 *
 * `second-reservation.test.ts` never saw it: it measures a request whose memos
 * are warm (or cold) at the START, never one where they lapse in the middle. So
 * here the clock is moved past every memo between any two reads of it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { _setConnectionTracing, tracedAcquisitionSite } from '../../db/connection-trace.js';
import { DDLManager } from '../../lib/data/index.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/index.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const C = `poolstall_${Date.now()}`;
const pool = Number(process.env.DB_POOL_MAX ?? '10');

/** Run `fn` with a clock that jumps past every in-process memo at each read. */
async function lapsing<T>(fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  let t = real();
  Date.now = () => {
    t += 301_000;
    return t;
  };
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

d('DR-40: memos lapsing mid-request take no second connection', () => {
  let app: Hono;
  let db: Database;
  let member = '';
  let god = '';
  let key = '';
  const list = (cookie: string) => app.request(`/api/data/${C}?limit=5`, { headers: { cookie } });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: C,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    god = await createGodSession(app, db);
    const created = await createMemberSession(app, db, {
      grants: [{ collection: C, actions: ['read', 'create'] }],
    });
    member = created.cookie;
    key = generateApiKey();
    await sql`
      INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, is_active, tenant_id, created_by)
      VALUES (${C}, ${await hashApiKey(key)}, ${key.slice(0, 12)},
              ${JSON.stringify([{ collection: C, actions: ['*'] }])}::jsonb, true,
              ${DEFAULT_TENANT_ID}::uuid, ${created.userId})`.execute(db);
    for (let i = 0; i < 12; i++) {
      const res = await app.request(`/api/data/${C}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: member },
        body: JSON.stringify({ title: `row ${i}` }),
      });
      expect(res.status).toBe(201);
    }
  }, 60_000);

  afterAll(async () => {
    _setConnectionTracing(false);
    if (!db) return;
    await sql`DELETE FROM zv_api_keys WHERE name = ${C}`.execute(db);
    await dropTestCollection(db, C);
  }, 60_000);

  it('a list (session, god, key, cursor, aggregate), a read and a write count no extra connection', async () => {
    const seen: Record<string, string> = {};
    const extra = (res: Response) => {
      const n = res.headers.get('x-zveltio-extra-connections') ?? '0';
      return `${res.status} ${n}${n === '0' ? '' : ` — ${tracedAcquisitionSite()}`}`;
    };
    _setConnectionTracing(true);
    try {
      await lapsing(async () => {
        seen['member list'] = extra(await list(member));
        seen['god list'] = extra(await list(god));
        seen['key list'] = extra(
          await app.request(`/api/data/${C}?limit=5`, { headers: { 'x-api-key': key } }),
        );
        const one = (await (await list(member)).json()) as {
          records: Array<{ id: string }>;
          next_cursor: string;
        };
        // Siblings through the same read gate: the keyset walk and the aggregate.
        seen['member cursor'] = extra(
          await app.request(
            `/api/data/${C}?limit=5&cursor=${encodeURIComponent(one.next_cursor)}`,
            { headers: { cookie: member } },
          ),
        );
        seen['member aggregate'] = extra(
          await app.request(`/api/data/${C}/aggregate?fn=count`, { headers: { cookie: member } }),
        );
        seen['member get'] = extra(
          await app.request(`/api/data/${C}/${one.records[0]!.id}`, {
            headers: { cookie: member },
          }),
        );
        seen['member write'] = extra(
          await app.request(`/api/data/${C}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', cookie: member },
            body: JSON.stringify({ title: 'probe' }),
          }),
        );
      });
    } finally {
      _setConnectionTracing(false);
    }
    expect(seen).toEqual({
      'member list': '200 0',
      'god list': '200 0',
      'key list': '200 0',
      'member cursor': '200 0',
      'member aggregate': '200 0',
      'member get': '200 0',
      'member write': '201 0',
    });
  }, 60_000);

  it(`${pool * 3} concurrent lists on a pool of ${pool} all answer, and soon`, async () => {
    // The stall itself, not its counter: every connection held by a request
    // waiting for a second one. Before the fix each waited out the 35 s acquire
    // timeout; with one connection per request they queue and finish.
    const started = performance.now();
    const statuses = await lapsing(() =>
      Promise.all(Array.from({ length: pool * 3 }, async () => (await list(member)).status)),
    );
    const seconds = (performance.now() - started) / 1000;
    expect({ statuses: [...new Set(statuses)], slow: seconds > 15 }).toEqual({
      statuses: [200],
      slow: false,
    });
  }, 90_000);
});
