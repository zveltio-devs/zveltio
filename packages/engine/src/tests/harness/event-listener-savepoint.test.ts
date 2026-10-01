/**
 * A record listener that fails inside the request transaction must not take
 * the write with it.
 *
 * `emitAsync` runs each listener inside its own SAVEPOINT on the request's
 * tenant transaction and rolls back to it when the listener throws. Without
 * that, a listener whose SQL errors leaves the transaction aborted (25P02) and
 * the write that triggered it fails — or, worse, a listener's half-done writes
 * commit alongside it. Only a real transaction shows either; the unit tests of
 * the bus run without one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { engineEvents } from '../../lib/runtime/index.js';
import { getCurrentTenantTrx } from '../../lib/tenancy/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hevt_${Date.now()}`;

d('a failing record listener inside the request transaction', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let off: (() => void) | null = null;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'label', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
  });

  afterAll(async () => {
    off?.();
    if (!db) return;
    await sql
      .raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  it('keeps the write, and undoes only what the listener did', async () => {
    let ranInTrx = false;
    off = engineEvents.on('record.created', (async (p: { collection: string }) => {
      if (p.collection !== COLLECTION) return;
      const trx = getCurrentTenantTrx();
      ranInTrx = Boolean(trx);
      if (!trx) return;
      // A side effect, then an SQL error — both inside the request transaction.
      await sql
        .raw(`INSERT INTO "zvd_${COLLECTION}" (label) VALUES ('from-listener')`)
        .execute(trx);
      await sql`SELECT 1 / 0`.execute(trx);
    }) as never);

    const res = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ label: 'from-request' }),
    });

    // Else the assertions below would pass without the savepoint ever running.
    expect(ranInTrx).toBe(true);
    expect(res.status).toBe(201);
    const rows = await sql<{ label: string }>`
      SELECT label FROM ${sql.table(`zvd_${COLLECTION}`)} ORDER BY label
    `.execute(db);
    expect(rows.rows.map((r) => r.label)).toEqual(['from-request']);
  });
});
