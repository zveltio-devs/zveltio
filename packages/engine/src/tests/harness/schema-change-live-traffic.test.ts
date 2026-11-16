/**
 * DR-43: a field added or retyped on a collection under live traffic must not
 * answer the traffic 500.
 *
 * Measured in LV-20: one `POST /api/collections/:name/fields` while 50 clients
 * read single records answered 30 of them `500 internal_error`, each logged as
 * `0A000 cached plan must not change result type`; a retype failed a read and a
 * write the same way. Every data request runs in a transaction, and a pooled
 * backend that prepared the record read or the write's `RETURNING *` before the
 * ALTER fails it there — the transaction is aborted, so nothing can retry it.
 * Recycling the pool after the change (`announceSchemaChange`) cannot reach a
 * request already holding an old backend, nor one queued behind the ALTER's
 * lock. The dialect therefore prepares nothing (`prepare: false`).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  asDefaultTenant,
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
  jobOutcome,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hlive_${Date.now()}`;
/** Below the harness pool (10): past it Bun.SQL waits on acquires, which is not this test. */
const CLIENTS = 8;

d('schema change under live traffic (DR-43)', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  let member = '';
  const ids: string[] = [];

  const call = (method: string, path: string, cookie: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: false, unique: false, indexed: false },
        { name: 'score', type: 'number', required: false, unique: false, indexed: false },
      ],
    } as never);
    ({ cookie: member } = await createMemberSession(app, db, {
      grants: [{ collection: COLLECTION, actions: ['read', 'update'] }],
    }));
    for (let i = 0; i < CLIENTS; i++) {
      const res = await call('POST', `/api/data/${COLLECTION}`, god, { title: `r${i}`, score: i });
      expect(res.status).toBe(201);
      ids.push(((await res.json()) as { id: string }).id);
    }
  });

  afterAll(async () => {
    if (db) await dropTestCollection(db, COLLECTION).catch(() => {});
  });

  /**
   * Each client reads and writes its own record in a loop until `change`
   * (and the job it may answer with) settles, then for a moment longer. Returns every non-2xx with its body.
   */
  const underTraffic = async (change: () => Response | Promise<Response>) => {
    let stop = false;
    const failures: string[] = [];
    const client = async (id: string, cookie: string) => {
      for (let i = 0; !stop; i++) {
        const res =
          i % 2 === 0
            ? await call('GET', `/api/data/${COLLECTION}/${id}`, cookie)
            : await call('PATCH', `/api/data/${COLLECTION}/${id}`, cookie, { title: `t${i}` });
        if (res.status >= 300) failures.push(`${res.status} ${(await res.text()).slice(0, 160)}`);
      }
    };
    const clients = ids.map((id, i) => client(id, i % 2 === 0 ? member : god));
    // Every pooled backend prepares both statements before the change.
    await Bun.sleep(400);
    // A change answered 202 runs as a job: the traffic lasts until it settles.
    expect(await jobOutcome(app, await change(), { cookie: god })).toMatch(/^(completed|2\d\d)$/);
    await Bun.sleep(400);
    stop = true;
    await Promise.all(clients);
    return failures;
  };

  it('adding a field answers no request 500', async () => {
    const failures = await underTraffic(() =>
      call('POST', `/api/collections/${COLLECTION}/fields`, god, { name: 'extra', type: 'text' }),
    );
    expect(failures).toEqual([]);
  }, 30_000);

  it('retyping a field answers no request 500', async () => {
    const failures = await underTraffic(() =>
      call('PATCH', `/api/collections/${COLLECTION}/fields/score`, god, { new_type: 'text' }),
    );
    const cols = await asDefaultTenant(
      db,
      sql<{ udt_name: string }>`
      SELECT udt_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ${`zvd_${COLLECTION}`}
         AND column_name = 'score'`,
    );
    expect(cols.rows[0]?.udt_name).toBe('text');
    expect(failures).toEqual([]);
  }, 30_000);
});
