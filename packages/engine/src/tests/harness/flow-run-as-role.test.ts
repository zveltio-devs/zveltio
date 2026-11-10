/**
 * ADR 0004 — a flow, a webhook and a data trigger run under a role chosen when
 * they are saved (`run_as_role`, migration 117).
 *
 * A flow step ran in its tenant with no actor, so the masking views (095) and
 * the row-rule policies stood down: `export_collection` returned the columns a
 * column rule hides and the rows a row rule hides, from the very admin who
 * wrote the flow. A webhook delivery and a data trigger's `trigger_data`
 * carried the record as stored. Each now reads as its role — Casbin, row rules
 * and column rules — and a flow whose role was deleted does not run.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { executeFlow, triggerDataFlows } from '../../lib/flows/index.js';
import { WebhookManager } from '../../lib/webhooks.js';
import {
  createRlsPolicy,
  deleteRlsPolicy,
  deleteRole,
  holdsRole,
  getEnforcer,
  invalidateUserPermCache,
  putColumnPermission,
} from '../../lib/tenancy/index.js';
import {
  asEveryTenant,
  asTenant,
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT = '00000000-0000-0000-0000-000000000001';
const STAMP = Date.now();
const COLL = `hrunas_${STAMP}`;
const ROLE = `runas_${STAMP}`;

const field = (name: string) => ({
  name,
  type: 'text',
  required: false,
  unique: false,
  indexed: false,
});

d('a flow runs under the role chosen at save (ADR 0004)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let godId = '';
  let recordId = '';
  let webhookId = '';
  const flows: string[] = [];

  const json = (method: string, body: unknown) => ({
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

  /** A flow inserted as the table holds it: `run_as_role` the migration's default, `tenant_member`. */
  const insertFlow = async (trigger: string, cfg: Record<string, unknown>, steps: unknown[]) => {
    const row = await asTenant(db, TENANT, (trx) =>
      sql<{ id: string }>`
        INSERT INTO zv_flows (tenant_id, name, trigger_type, trigger_config, is_active)
        VALUES (${TENANT}, ${`runas-${STAMP}-${flows.length}`}, ${trigger},
                ${JSON.stringify(cfg)}::jsonb, true)
        RETURNING id::text AS id`.execute(trx),
    );
    const id = row.rows[0]!.id;
    flows.push(id);
    for (const [i, step] of steps.entries()) {
      await sql`
        INSERT INTO zv_flow_steps (flow_id, step_order, name, type, config, on_error)
        VALUES (${id}, ${i}, ${`s${i}`}, ${(step as { type: string }).type},
                ${JSON.stringify((step as { config: unknown }).config)}::jsonb, 'stop')
      `.execute(db);
    }
    return id;
  };

  const exportFlow = () =>
    insertFlow('manual', {}, [{ type: 'export_collection', config: { collection: COLL } }]);

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    const me = (await (await app.request('/api/me', { headers: { cookie } })).json()) as {
      user: { id: string };
    };
    godId = me.user.id;

    await DDLManager.createCollection(db, {
      name: COLL,
      adoptRules: true,
      fields: [field('title'), field('secret'), field('owner')],
    } as never);
    recordId = (
      await asTenant(db, TENANT, (trx) =>
        sql<{ id: string }>`
          INSERT INTO ${sql.table(`zvd_${COLL}`)} (tenant_id, title, secret, owner)
          VALUES (${TENANT}::uuid, 'visible-title', 'classified', 'nobody') RETURNING id`.execute(
          trx,
        ),
      )
    ).rows[0]!.id;

    // `secret` is hidden from members: the column role of every account, and of every flow.
    await putColumnPermission(db, {
      collection_name: COLL,
      column_name: 'secret',
      role: 'member',
      can_read: false,
      can_write: false,
    });
    const e = await getEnforcer();
    await e.addPolicy(ROLE, '*', COLL, 'read');
  });

  afterAll(async () => {
    if (!db) return;
    for (const id of flows) {
      await sql`DELETE FROM zv_flow_runs WHERE flow_id = ${id}`.execute(db).catch(() => {});
      await sql`DELETE FROM zv_flow_steps WHERE flow_id = ${id}`.execute(db).catch(() => {});
      await asEveryTenant(db, (trx) => sql`DELETE FROM zv_flows WHERE id = ${id}`.execute(trx));
    }
    if (webhookId) {
      await asEveryTenant(db, async (trx) => {
        await sql`DELETE FROM zvd_webhook_deliveries WHERE webhook_id = ${webhookId}`.execute(trx);
        await sql`DELETE FROM zvd_webhooks WHERE id = ${webhookId}`.execute(trx);
      }).catch(() => {});
    }
    const e = await getEnforcer();
    await e.removeFilteredPolicy(0, ROLE).catch(() => {});
    await e.removeFilteredGroupingPolicy(1, ROLE).catch(() => {});
    await sql`DELETE FROM zvd_column_permissions WHERE collection_name = ${COLL}`
      .execute(db)
      .catch(() => {});
    await dropTestCollection(db, COLL).catch(() => {});
  });

  it('export_collection reads through the masking view as the role: the hidden column stays out', async () => {
    const res = await executeFlow(db, await exportFlow());
    expect(res.error).toBeUndefined();
    const csv = String(res.output.csv);
    expect(csv).toContain('visible-title');
    expect(csv).not.toContain('classified');
  });

  it("export_collection meets the role's row rules: `user_id` owns nothing for a flow", async () => {
    const rule = await createRlsPolicy({
      collection: COLL,
      role: 'member',
      filter_field: 'owner',
      filter_op: 'eq',
      filter_value_source: 'user_id',
    });
    try {
      const res = await executeFlow(db, await exportFlow());
      expect(res.error).toBeUndefined();
      expect(res.output.rows).toBe(0);
    } finally {
      await deleteRlsPolicy(rule.id);
    }
  });

  it('a webhook delivery carries the record as its role reads it', async () => {
    webhookId = (
      await asTenant(db, TENANT, (trx) =>
        sql<{ id: string }>`
          INSERT INTO zvd_webhooks (name, url, events, collections, active, tenant_id)
          VALUES (${`runas-${STAMP}`}, 'https://example.test/hook', ARRAY['insert'],
                  ARRAY[${COLL}], true, ${TENANT}::uuid)
          RETURNING id::text AS id`.execute(trx),
      )
    ).rows[0]!.id;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({ ok: true, status: 200, text: async () => 'ok' }) as Response) as unknown as typeof fetch;
    try {
      await WebhookManager.trigger(
        'insert',
        COLL,
        { id: recordId, title: 'visible-title', secret: 'classified', owner: 'nobody' },
        TENANT,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    const rows = await asEveryTenant(db, (trx) =>
      sql<{ payload: unknown }>`
        SELECT payload FROM zvd_webhook_deliveries WHERE webhook_id = ${webhookId}`.execute(trx),
    );
    expect(rows.rows.length).toBe(1);
    const payload = JSON.stringify(rows.rows[0]!.payload);
    expect(payload).toContain('visible-title');
    expect(payload).not.toContain('classified');
  });

  it("a data trigger's trigger_data carries the record as its role reads it", async () => {
    const flowId = await insertFlow('on_create', { collection: COLL }, [
      { type: 'condition', config: { expression: 'true' } },
    ]);
    await triggerDataFlows(
      db,
      COLL,
      'insert',
      { id: recordId, title: 'visible-title', secret: 'classified', owner: 'nobody' },
      TENANT,
    );
    let run: { status: string; trigger_data: unknown } | undefined;
    for (let i = 0; i < 50 && run?.status !== 'success'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      run = (
        await sql<{ status: string; trigger_data: unknown }>`
          SELECT status, trigger_data FROM zv_flow_runs WHERE flow_id = ${flowId}`.execute(db)
      ).rows[0];
    }
    expect(run?.status).toBe('success');
    const data = JSON.stringify(run?.trigger_data);
    expect(data).toContain('visible-title');
    expect(data).not.toContain('classified');
  });

  it('a tenant admin may save a flow or webhook to run as any role; a member only as one they hold', async () => {
    // The routes are tenant-admin only, so the member half is asked directly.
    const body = { name: `runas-save-${STAMP}`, trigger: { type: 'manual' }, run_as_role: ROLE };
    const saved = await app.request('/api/flows', json('POST', body));
    expect(saved.status).toBe(201);
    const flow = ((await saved.json()) as { flow: { id: string; run_as_role: string } }).flow;
    flows.push(flow.id);
    expect(flow.run_as_role).toBe(ROLE);

    const memberId = `runas-member-${STAMP}`;
    const e = await getEnforcer();
    await e.addRoleForUser(memberId, 'member', '*');
    try {
      expect(await asTenant(db, TENANT, () => holdsRole(memberId, ROLE))).toBe(false);
      await e.addRoleForUser(memberId, ROLE, '*');
      await invalidateUserPermCache(memberId);
      expect(await asTenant(db, TENANT, () => holdsRole(memberId, ROLE))).toBe(true);
    } finally {
      await e.deleteUser(memberId);
      await invalidateUserPermCache(memberId);
    }
  });

  it('a flow whose role was deleted fails closed', async () => {
    const flowId = await exportFlow();
    await asTenant(db, TENANT, (trx) =>
      sql`UPDATE zv_flows SET run_as_role = ${ROLE} WHERE id = ${flowId}`.execute(trx),
    );
    expect((await executeFlow(db, flowId)).status).toBe('success');

    await deleteRole(db, ROLE);
    const res = await executeFlow(db, flowId);
    expect(res.status).toBe('failed');
    expect(res.error).toContain('run_as_role');
    expect(String(res.output?.csv ?? '')).not.toContain('visible-title');
  });
});
