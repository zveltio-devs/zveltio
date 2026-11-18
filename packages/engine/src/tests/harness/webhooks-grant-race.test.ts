/**
 * A webhook job must not drop the first records of a collection whose default
 * grant has not reached this instance yet (DR-TASKS, from #1743).
 *
 * With several instances, the one that creates a collection writes its default
 * grants and announces them on the bus; a record written right after can have its
 * webhook job picked up by another instance in the milliseconds before that
 * message lands. Its model then says the webhook's role cannot read the record,
 * and the event was counted as skipped and lost. The test builds that state on one
 * instance: the grant is in `zvd_permissions` but not in the live model, exactly
 * what the receiving side of a late message looks like.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  DEFAULT_RUN_AS_ROLE,
  getEnforcer,
  invalidateAllPermissionCaches,
  reconcilePolicies,
} from '../../lib/tenancy/index.js';
import {
  asDefaultTenant,
  createGodSession,
  drainWebhookJobs,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `whrace_${Date.now()}`;

type Row = { v0: string; v1: string; v2: string; v3: string };

d('webhook job on an instance the default grant has not reached', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let webhookId = '';
  let originalFetch: typeof fetch;

  beforeAll(async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({ ok: true, status: 200, text: async () => 'ok' }) as Response) as unknown as typeof fetch;

    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
    const res = await app.request('/api/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: `Grant race ${COLLECTION}`,
        url: 'https://example.test/hook',
        events: ['insert'],
        collections: [COLLECTION],
      }),
    });
    const body = (await res.json()) as { id?: string; webhook?: { id: string } };
    webhookId = body.id ?? body.webhook!.id;
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    if (!db) return;
    if (webhookId) {
      await asDefaultTenant(
        db,
        sql`DELETE FROM zvd_webhook_deliveries WHERE webhook_id = ${webhookId}`,
      ).catch(() => {});
      await asDefaultTenant(db, sql`DELETE FROM zvd_webhooks WHERE id = ${webhookId}`).catch(
        () => {},
      );
    }
    await sql`DELETE FROM zvd_permissions WHERE v2 = ${COLLECTION}`.execute(db).catch(() => {});
    await sql
      .raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
    await reconcilePolicies();
  });

  it('reconciles with the table before counting the record as unreadable', async () => {
    const grants = (
      await sql<Row>`SELECT v0, v1, v2, v3 FROM zvd_permissions
                     WHERE ptype = 'p' AND v0 = ${DEFAULT_RUN_AS_ROLE} AND v2 = ${COLLECTION}`.execute(
        db,
      )
    ).rows;
    expect(grants.some((g) => g.v3 === 'read')).toBe(true);

    // Before the grant: neither the table nor the model holds it, and this
    // instance has settled on that table.
    await sql`DELETE FROM zvd_permissions
              WHERE ptype = 'p' AND v0 = ${DEFAULT_RUN_AS_ROLE} AND v2 = ${COLLECTION}`.execute(db);
    const e = await getEnforcer();
    for (const g of grants) await e.selfRemovePolicy('p', 'p', [g.v0, g.v1, g.v2, g.v3]);
    await invalidateAllPermissionCaches();
    await reconcilePolicies();

    // The creating instance writes the grant; its bus message has not arrived here.
    for (const g of grants) {
      await sql`INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3)
                VALUES ('p', ${g.v0}, ${g.v1}, ${g.v2}, ${g.v3})`.execute(db);
    }

    const res = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'first record' }),
    });
    expect([200, 201]).toContain(res.status);
    await drainWebhookJobs(db);

    const delivered = await asDefaultTenant(
      db,
      sql<{ count: string }>`SELECT count(*)::text AS count FROM zvd_webhook_deliveries
                             WHERE webhook_id = ${webhookId}`,
    );
    // A skipped event writes no delivery row; an announced one writes one per attempt.
    expect(Number(delivered.rows[0]?.count ?? 0)).toBeGreaterThanOrEqual(1);
  });
});
