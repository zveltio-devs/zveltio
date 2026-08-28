/**
 * A missing extension table must not abort the caller's transaction.
 *
 * `getRuleGroups` used to SELECT from `zvd_validation_rule_groups` and catch the
 * failure, on the grounds that the table is absent whenever the
 * `developer/validation` extension is not installed — the state of most
 * instances. The return value was right; the transaction was not. `42P01` aborts
 * it, a JavaScript `catch` does not undo that, and every later statement answers
 * `25P02 current transaction is aborted` — including statements belonging to a
 * DIFFERENT request, once the connection goes back to the pool.
 *
 * Traced in CI on 2026-08-28: the failing read happened during
 * `POST /api/data/hist_probe_…`; a later `GET` on the same collection died on
 * its first statement, `select * from zvd_collections where name = $1`, having
 * done nothing wrong itself. E2E failed that way in 8 of 19 runs.
 *
 * The property asserted here is the one that was violated: with the table
 * absent, a write and the read that follows it both succeed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import { validateRecord } from '../../lib/validation-engine.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `poisonprobe_${Date.now()}`;

d('a missing extension table does not poison the request transaction', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let tableAbsent = false;

  beforeAll(async () => {
    const ctx = await getTestApp();
    app = ctx.app;
    db = ctx.db;
    cookie = await createGodSession(app, db);

    const probe = await sql<{ present: boolean }>`
      SELECT to_regclass('zvd_validation_rule_groups') IS NOT NULL AS present
    `.execute(db);
    tableAbsent = probe.rows[0]?.present !== true;

    await app.request('/api/collections', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: COLLECTION, fields: [{ name: 'title', type: 'text' }] }),
    });
  });

  afterAll(async () => {
    await db
      ?.deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  it('the table really is absent — otherwise this test proves nothing', () => {
    // Guard, not an assumption. With `developer/validation` installed the read
    // succeeds and the regression cannot show itself; saying so out loud beats a
    // green tick that means "not exercised".
    expect(tableAbsent).toBe(true);
  });

  it('leaves the enclosing transaction usable', async () => {
    // The symptom — a 500 on some later request — is not reproducible in one
    // process: the poison travelled on a pooled connection to whoever drew it
    // next. A first version of this test asserted the symptom, passed against
    // the unfixed code, and would have guarded nothing.
    //
    // So assert the mechanism instead. Run the validation inside an explicit
    // transaction and then use that transaction. Before the fix the SELECT on
    // the absent table aborted it and this statement answered 25P02.
    await db.transaction().execute(async (trx) => {
      await validateRecord(trx as unknown as Database, COLLECTION, { title: 'x' });
      const after = await sql<{ ok: number }>`SELECT 1 AS ok`.execute(trx);
      expect(after.rows[0]?.ok).toBe(1);
    });
  });

  it('a write succeeds, and so does the read that follows it', async () => {
    const created = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'keep me' }),
    });
    expect(created.status, await created.clone().text()).toBeLessThan(300);

    const listed = await app.request(`/api/data/${COLLECTION}?limit=1`, { headers: { cookie } });
    expect(listed.status, await listed.clone().text()).toBe(200);
  });
});
