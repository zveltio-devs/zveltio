/**
 * A field added to a collection must not leave a pooled `SELECT *` over its
 * table failing.
 *
 * The engine's own record reads go through the masking view under a statement
 * text that changes with the view's oid (`readSource`), so they are prepared
 * afresh. Everything else that reads a collection table with `SELECT *` keeps
 * one text: a flow's `export_collection` step, an extension hook's before-row
 * (`snapshotQuery`), an extension's own `ctx.db` query. Each pooled backend
 * that prepared it before the column appeared answers `0A000 cached plan must
 * not change result type` — inside a transaction, where the dialect cannot
 * retry, as a failure — until that backend goes away. `announceSchemaChange`
 * replaces the pool, here and (through the bus) on every replica.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getActiveBunPool } from '../../db/bun-sql-dialect.js';
import { databaseDriver } from '../../db/pg-dialect.js';
import { DDLManager } from '../../lib/data/index.js';
import { executeFlow } from '../../lib/flows/index.js';
import { dispatchToWs, SCHEMA_CHANGED_EVENT } from '../../lib/runtime/index.js';
import {
  asEveryTenant,
  asTenant,
  createGodSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

// `pg` sends unnamed statements: no plan outlives the ALTER.
const d = harnessAvailable() && databaseDriver() === 'bun' ? describe : describe.skip;
const DEFAULT_TENANT = '00000000-0000-0000-0000-000000000001';
const COLLECTION = `hstale_${Date.now()}`;

d('a field added under a pooled SELECT *', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let flowId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    await asTenant(db, DEFAULT_TENANT, (trx) =>
      sql`INSERT INTO ${sql.id(`zvd_${COLLECTION}`)} (title) VALUES ('a')`.execute(trx),
    );
    const flow = await asTenant(db, DEFAULT_TENANT, (trx) =>
      sql<{ id: string }>`
        INSERT INTO zv_flows (tenant_id, name, trigger_type, trigger_config, is_active)
        VALUES (${DEFAULT_TENANT}, ${`stale-${COLLECTION}`}, 'manual', '{}'::jsonb, true)
        RETURNING id::text AS id`.execute(trx),
    );
    flowId = flow.rows[0]!.id;
    await sql`
      INSERT INTO zv_flow_steps (flow_id, step_order, name, type, config, on_error)
      VALUES (${flowId}, 0, 'export', 'export_collection',
              ${JSON.stringify({ collection: COLLECTION })}::jsonb, 'stop')`.execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_flow_runs WHERE flow_id = ${flowId}`.execute(db).catch(() => {});
    await sql`DELETE FROM zv_flow_steps WHERE flow_id = ${flowId}`.execute(db).catch(() => {});
    await asEveryTenant(db, (trx) =>
      sql`DELETE FROM zv_flows WHERE id = ${flowId}`.execute(trx),
    ).catch(() => {});
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

  // Rounds of concurrent runs, so the step's transaction meets every pooled
  // backend. No more at once than the pool holds: past it, Bun.SQL can stall a
  // mix of reserved transactions and pool queries until the acquire deadline.
  const exportAll = async () => {
    const failed: unknown[] = [];
    for (let round = 0; round < 4; round++) {
      const runs = await Promise.all(Array.from({ length: 8 }, () => executeFlow(db, flowId)));
      failed.push(...runs.filter((r) => r.status !== 'success').map((r) => r.error ?? r.output));
    }
    return failed;
  };

  it('serves a flow export after POST /api/collections/:name/fields', async () => {
    expect(await exportAll()).toEqual([]);

    const res = await app.request(`/api/collections/${COLLECTION}/fields`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: 'extra', type: 'text' }),
    });
    expect(res.status).toBeLessThan(300);

    expect(await exportAll()).toEqual([]);
  }, 60_000);

  it('replaces the pool when another replica announces the change', async () => {
    const before = getActiveBunPool();
    await dispatchToWs({
      originId: 'replica-b',
      event: SCHEMA_CHANGED_EVENT,
      collection: COLLECTION,
      data: { action: 'alter' },
      timestamp: new Date().toISOString(),
    });
    // Coalesced: a burst of announcements costs one recycle, half a second on.
    for (let i = 0; i < 40 && getActiveBunPool() === before; i++) await Bun.sleep(50);
    expect(getActiveBunPool()).not.toBe(before);
  }, 10_000);
});
