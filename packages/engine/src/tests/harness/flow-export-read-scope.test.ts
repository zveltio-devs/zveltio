/**
 * A flow's `export_collection` step serves what REST would: its own firm's rows,
 * no `password` hash, no ciphertext, and only a collection.
 *
 * It read `SELECT * FROM "zvd_<x>"` on the engine's own connection with nothing
 * but `zveltio.current_tenant` set. That connection is a superuser on a stock
 * install, so FORCE RLS did not bind it: the CSV carried every firm's rows and
 * the password column served to no one, and `collection: 'permissions'` exported
 * the instance's Casbin table. A tenant admin may author this step.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { executeFlow } from '../../lib/flows/index.js';
import {
  asEveryTenant,
  asTenant,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const DEFAULT_TENANT = '00000000-0000-0000-0000-000000000001';
const STAMP = Date.now();
const OTHER_TENANT = `00000000-0000-0000-0000-${String(STAMP).slice(-12).padStart(12, '0')}`;
const COLL = `hflowexp_${STAMP}`;

const field = (name: string, type = 'text') => ({
  name,
  type,
  required: false,
  unique: false,
  indexed: false,
});

d('flow export_collection reads as REST serves', () => {
  let db: Database;
  const flows: string[] = [];

  const runExport = async (config: Record<string, unknown>) => {
    const row = await asTenant(db, DEFAULT_TENANT, (trx) =>
      sql<{ id: string }>`
        INSERT INTO zv_flows (tenant_id, name, trigger_type, trigger_config, is_active)
        VALUES (${DEFAULT_TENANT}, ${`exp-${STAMP}-${flows.length}`}, 'manual', '{}'::jsonb, true)
        RETURNING id::text AS id`.execute(trx),
    );
    const flowId = row.rows[0]!.id;
    flows.push(flowId);
    await sql`
      INSERT INTO zv_flow_steps (flow_id, step_order, name, type, config, on_error)
      VALUES (${flowId}, 0, 'export', 'export_collection', ${JSON.stringify(config)}::jsonb, 'stop')
    `.execute(db);
    return executeFlow(db, flowId);
  };

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${OTHER_TENANT}::uuid, ${`flowexp-${STAMP}`}, 'flowexp', 'active')
              ON CONFLICT (id) DO NOTHING`.execute(db);
    await DDLManager.createCollection(db, {
      name: COLL,
      adoptRules: true,
      fields: [field('title'), field('pw', 'password')],
    } as never);
    for (const [tenant, title] of [
      [DEFAULT_TENANT, 'mine'],
      [OTHER_TENANT, 'foreign'],
    ]) {
      // In its own firm: a non-superuser owner is bound by FORCE RLS.
      await asTenant(db, tenant!, (trx) =>
        sql`INSERT INTO ${sql.table(`zvd_${COLL}`)} (tenant_id, title, pw)
            VALUES (${tenant}::uuid, ${title}, ${`hash-of-${title}`})`.execute(trx),
      );
    }
  });

  afterAll(async () => {
    if (!db) return;
    for (const id of flows) {
      await sql`DELETE FROM zv_flow_runs WHERE flow_id = ${id}`.execute(db).catch(() => {});
      await sql`DELETE FROM zv_flow_steps WHERE flow_id = ${id}`.execute(db).catch(() => {});
      await asEveryTenant(db, (trx) => sql`DELETE FROM zv_flows WHERE id = ${id}`.execute(trx));
    }
    await dropTestCollection(db, COLL).catch(() => {});
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER_TENANT}::uuid`.execute(db).catch(() => {});
  });

  it("exports the flow's own firm, without the password hash", async () => {
    const res = await runExport({ collection: COLL });
    expect(res.error).toBeUndefined();
    const csv = String(res.output.csv);
    expect(csv).toContain('"mine"');
    expect(csv).not.toContain('foreign');
    expect(csv).not.toContain('hash-of-');
    expect(csv.split('\r\n')[0]).not.toContain('"pw"');
  });

  it('a column the author names that REST never serves stays out', async () => {
    const res = await runExport({ collection: COLL, columns: ['title', 'pw'] });
    expect(String(res.output.csv)).not.toContain('hash-of-');
  });

  it('refuses an engine table that is not a collection', async () => {
    const res = await runExport({ collection: 'permissions' });
    expect(res.status).toBe('failed');
    expect(String(res.output?.csv ?? '')).not.toContain('ptype');
  });
});
