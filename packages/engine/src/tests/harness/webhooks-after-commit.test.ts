/**
 * A webhook fires for a write that COMMITTED, never for one that rolled back.
 *
 * `afterWrite` awaited `WebhookManager.trigger` inside the request's
 * transaction, and `trigger` looks up the hooks and writes the delivery rows in
 * a transaction of its OWN, then starts the delivery. So the outside world was
 * told about a record before the request had committed it — and when the commit
 * then failed, the record was gone and the POST had already left.
 *
 * The rollback here is a real one on the real route: a deferred constraint
 * trigger that refuses the row at COMMIT, after the handler — and `afterWrite`
 * — have run. The dispatcher runs on a pool whose every connection is the plain
 * role, as in `webhooks-rls.test.ts`, and the write is in a non-default firm, so
 * the committed control also proves the firm is still carried after the commit.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { Kysely, sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { BunSqlDialect } from '../../db/bun-sql-dialect.js';
import type { DbSchema } from '../../db/schema.js';
import { DDLManager } from '../../lib/data/index.js';
import { WebhookManager, _settleWebhookDeliveries } from '../../lib/webhooks.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const OTHER = crypto.randomUUID();
const SLUG = `whac-${OTHER.slice(0, 8)}`;
const STAMP = `whac_${Date.now()}`;
const COLLECTION = `${STAMP}_c`;
const TABLE = `zvd_${COLLECTION}`;
const FN = `${STAMP}_refuse`;

function plainRoleUrl(): string {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.searchParams.set('options', '-c role=zveltio_rls');
  return url.toString();
}

d('webhooks fire after the commit', () => {
  let app: Hono;
  let db: Database;
  let plain: Database;
  let god = '';
  let hook = '';
  let originalFetch: typeof fetch;
  const sent: string[] = [];

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    plain = new Kysely<DbSchema>({
      dialect: new BunSqlDialect({ connectionString: plainRoleUrl(), max: 4 }),
    }) as unknown as Database;
    god = await createGodSession(app, db);
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${OTHER}::uuid, ${SLUG}, ${SLUG}, 'active')`.execute(db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
    // Refuses a row titled `refuse` — at COMMIT, not at the INSERT.
    await sql
      .raw(`CREATE FUNCTION "${FN}"() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              IF NEW.title = 'refuse' THEN RAISE EXCEPTION 'refused at commit'; END IF;
              RETURN NULL;
            END $$`)
      .execute(db);
    await sql
      .raw(`CREATE CONSTRAINT TRIGGER "${STAMP}_t" AFTER INSERT ON "${TABLE}"
            DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "${FN}"()`)
      .execute(db);
    const row = await sql<{ id: string }>`
      INSERT INTO zvd_webhooks (tenant_id, name, url, events, collections, secret, retry_attempts)
      VALUES (${OTHER}::uuid, ${STAMP}, 'https://example.com/whac',
              ARRAY['*']::text[], ARRAY[${COLLECTION}]::text[], NULL, 0)
      RETURNING id::text AS id`.execute(db);
    hook = row.rows[0]!.id;

    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      // Only this file's: another file's retries can still be in flight.
      const body = String(init?.body ?? '');
      if (body.includes(COLLECTION)) sent.push(body);
      return { status: 200, ok: true, text: async () => 'ok' } as Response;
    }) as unknown as typeof fetch;
    WebhookManager.init(plain);
  }, 60_000);

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    WebhookManager.init(db);
    await plain?.destroy().catch(() => undefined);
    if (!db) return;
    await sql`DELETE FROM zvd_webhooks WHERE name = ${STAMP}`.execute(db);
    await sql.raw(`DROP TABLE IF EXISTS "${TABLE}" CASCADE`).execute(db);
    await sql.raw(`DROP FUNCTION IF EXISTS "${FN}"()`).execute(db);
    await sql`DELETE FROM zvd_collections WHERE name = ${COLLECTION}`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER}::uuid`.execute(db);
  });

  const write = (title: string) =>
    app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god, 'X-Tenant-Slug': SLUG },
      body: JSON.stringify({ title }),
    });

  const deliveries = async () =>
    (
      await sql<{ tenant_id: string; title: string }>`
        SELECT tenant_id::text AS tenant_id, payload->'data'->>'title' AS title
          FROM zvd_webhook_deliveries WHERE webhook_id = ${hook}::uuid`.execute(db)
    ).rows;

  it('a write that rolls back at commit fires nothing', async () => {
    // The status is not asserted: the handler's 201 is already on the context
    // when the COMMIT fails, and that is a separate question from this one.
    await write('refuse');
    await _settleWebhookDeliveries();
    const kept = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.table(TABLE)}`.execute(db);
    expect(kept.rows[0]!.n).toBe(0); // the rollback is real
    expect(await deliveries()).toEqual([]);
    expect(sent).toEqual([]);
  }, 30_000);

  it('a write that commits delivers, as its own firm', async () => {
    const res = await write('kept');
    expect(res.status).toBe(201);
    await _settleWebhookDeliveries();
    expect(await deliveries()).toEqual([{ tenant_id: OTHER, title: 'kept' }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('"kept"');
  }, 30_000);
});
