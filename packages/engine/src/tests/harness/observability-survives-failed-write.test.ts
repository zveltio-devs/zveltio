/**
 * The three after-response writers must survive a request that failed.
 *
 * `requestLogMiddleware`, `slowQueryMiddleware` and `godAuditMiddleware` all
 * issue their INSERT after `next()` and deliberately do not await it. Given the
 * request-scoped proxy they resolved the request's tenant transaction, and a
 * request that failed on a database error leaves that transaction aborted — so
 * every one of those writes came back "current transaction is aborted, commands
 * ignored until end of transaction block" and was dropped with nothing but a
 * console line.
 *
 * Which is the inversion worth a test: request-log states that failures are
 * never sampled away, and god-audit is the accountability trail for the role
 * that bypasses every permission check. Both went silent on exactly the
 * requests worth keeping.
 *
 * The write is not awaited by the handler, so each assertion polls rather than
 * reading once.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const PARENTS = `hobsp_${Date.now()}`;
const CHILDREN = `hobsc_${Date.now()}`;

/** Poll until `read` returns a row, or give up. Returns undefined on timeout. */
async function eventually<T>(
  read: () => Promise<T | undefined>,
  ms = 5000,
): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const row = await read();
    if (row) return row;
    if (Date.now() > deadline) return undefined;
    await Bun.sleep(50);
  }
}

d('after-response writers survive a failed write (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  const path = () => `/api/data/${CHILDREN}`;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: PARENTS,
      fields: [{ name: 'name', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
    await DDLManager.createCollection(db, {
      name: CHILDREN,
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        {
          name: 'parent',
          type: 'reference',
          required: false,
          unique: false,
          indexed: false,
          options: { related_collection: PARENTS, on_delete: 'SET NULL' },
        },
      ],
    } as never);

    // The write that aborts the request's transaction: a reference to a parent
    // id that does not exist.
    const res = await app.request(path(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'Orphan', parent: '00000000-0000-0000-0000-000000000099' }),
    });
    expect([400, 409, 422]).toContain(res.status);
  });

  afterAll(async () => {
    if (!db) return;
    for (const name of [CHILDREN, PARENTS]) {
      await sql
        .raw(`DROP TABLE IF EXISTS "zvd_${name}" CASCADE`)
        .execute(db)
        .catch(() => {});
      await db
        .deleteFrom('zvd_collections')
        .where('name', '=', name)
        .execute()
        .catch(() => {});
    }
    await db
      .deleteFrom('zvd_relations')
      .where('source_collection', '=', CHILDREN)
      .execute()
      .catch(() => {});
    await db
      .deleteFrom('zv_request_logs')
      .where('path', '=', path())
      .execute()
      .catch(() => {});
    await db
      .deleteFrom('zv_audit_log')
      .where('resource_id', '=', path())
      .execute()
      .catch(() => {});
  });

  it('records the failed request in zv_request_logs', async () => {
    const row = await eventually(() =>
      db
        .selectFrom('zv_request_logs')
        .select(['status'])
        .where('path', '=', path())
        .where('method', '=', 'POST')
        .executeTakeFirst(),
    );
    expect(row).toBeDefined();
    expect(row?.status).toBeGreaterThanOrEqual(400);
  });

  it('records the god action that failed in zv_audit_log', async () => {
    const row = await eventually(() =>
      db
        .selectFrom('zv_audit_log')
        .select(['event_type'])
        .where('resource_id', '=', path())
        .where('event_type', '=', 'god_action')
        .executeTakeFirst(),
    );
    expect(row).toBeDefined();
  });
});
