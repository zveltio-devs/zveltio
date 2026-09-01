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

  it('probing a name that does not exist leaves the transaction usable', async () => {
    // The mechanism, asserted without depending on what is installed here.
    //
    // This is the shape `hasRuleGroupsTable` uses, and the reason the bug is
    // fixed: `to_regclass` RETURNS NULL for an absent name instead of raising,
    // so it cannot abort anything, whereas the `SELECT … FROM <missing table>`
    // it replaced raised 42P01 and poisoned the connection for whoever drew it
    // next from the pool.
    //
    // The name below cannot exist, so this runs identically on every instance —
    // with the validation extension installed or not. That matters: the guard
    // below can only report the ambient state, and a test that silently stops
    // exercising its subject depending on which extensions an operator happens
    // to have is not a test of anything.
    await db.transaction().execute(async (trx) => {
      const probe = await sql<{ present: boolean }>`
        SELECT to_regclass('zvd_no_such_table_ever_42p01') IS NOT NULL AS present
      `.execute(trx);
      expect(probe.rows[0]?.present).toBe(false);
      // The statement that used to answer 25P02.
      const after = await sql<{ ok: number }>`SELECT 1 AS ok`.execute(trx);
      expect(after.rows[0]?.ok).toBe(1);
    });
  });

  it('reports whether the absent-table path was exercised on this database', () => {
    // Reporting, not failing — and the difference took a whole session to earn.
    //
    // This used to `expect(tableAbsent).toBe(true)`, on the reasoning that a
    // green tick meaning "not exercised" is worse than a red one. The reasoning
    // is right; the red was still wrong, because the condition is a legitimate
    // configuration — install `developer/validation` and the suite goes red on
    // a database where nothing is broken. A suite that is red for a legitimate
    // configuration teaches people to read past red, and on 2026-08-31 that is
    // exactly what happened here: 108 failures that meant nothing, with four
    // real defects hiding inside them.
    //
    // What made the red unnecessary is the test above, which exercises the
    // mechanism deterministically everywhere. This one now only says which
    // world this run was in.
    if (!tableAbsent) {
      console.warn(
        '[poison-probe] `developer/validation` is installed here, so the ' +
          'end-to-end absent-table path could not be exercised on this database. ' +
          'The mechanism is still covered by the deterministic probe above.',
      );
    }
    expect(typeof tableAbsent).toBe('boolean');
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
