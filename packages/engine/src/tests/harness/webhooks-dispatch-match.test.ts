/**
 * Which of a firm's webhooks the dispatcher picks for an event.
 *
 * Every webhook test seeds `active: true` and `collections: []`, so deleting
 * `active = true` from the match, or either of the "every collection" readings
 * (`collections IS NULL`, `'*'`), left all 25 webhook test files green. A
 * disabled webhook would then keep POSTing record data to its URL, and a hook
 * created without a collection list, or with `*`, would silently never fire.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DEFAULT_TENANT_ID } from '../../lib/route-db.js';
import { _settleWebhookDeliveries, WebhookManager } from '../../lib/webhooks.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TAG = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const COLLECTION = `wdm_${TAG}`;
const OTHER_TENANT = crypto.randomUUID();

d('webhook dispatch: which hooks match', () => {
  let db: Database;
  const ids: Record<string, string> = {};

  const hook = async (
    name: string,
    active: boolean,
    collections: string[] | null,
    { events = ['insert'], tenant = DEFAULT_TENANT_ID } = {},
  ) => {
    const row = await sql<{ id: string }>`
      INSERT INTO zvd_webhooks (name, url, method, events, collections, active, retry_attempts, timeout, tenant_id)
      VALUES (${`${name}-${TAG}`}, 'http://127.0.0.1:9/hook', 'POST', ARRAY[${sql.join(events)}]::text[],
              ${collections === null ? null : collections.length === 0 ? sql`'{}'::text[]` : sql`ARRAY[${sql.join(collections)}]::text[]`},
              ${active}, 0, 1000, ${tenant}::uuid)
      RETURNING id::text AS id
    `.execute(db);
    ids[name] = row.rows[0]!.id;
  };

  beforeAll(async () => {
    ({ db } = await getTestApp());
    WebhookManager.init(db);
    await hook('inactive', false, [COLLECTION]);
    await hook('null-collections', true, null);
    await hook('star-collections', true, ['*']);
    await hook('named', true, [COLLECTION]);
    await hook('other-collection', true, [`other_${TAG}`]);
    await hook('empty-collections', true, []);
    await hook('star-events', true, [COLLECTION], { events: ['*'] });
    await hook('other-event', true, [COLLECTION], { events: ['delete'] });
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${OTHER_TENANT}::uuid, ${`wdm-${TAG}`}, ${`wdm-${TAG}`}, 'active')`.execute(
      db,
    );
    await hook('other-tenant', true, [COLLECTION], { tenant: OTHER_TENANT });
  });

  afterAll(async () => {
    if (!db) return;
    await _settleWebhookDeliveries();
    for (const id of Object.values(ids)) {
      await sql`DELETE FROM zvd_webhook_deliveries WHERE webhook_id = ${id}::uuid`.execute(db);
      await sql`DELETE FROM zvd_webhooks WHERE id = ${id}::uuid`.execute(db);
    }
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER_TENANT}::uuid`.execute(db);
  });

  it('fires active hooks for the collection, by name, NULL or *; not inactive or other ones', async () => {
    await WebhookManager.trigger(
      'insert',
      COLLECTION,
      { id: '00000000-0000-4000-8000-0000000000ab' },
      DEFAULT_TENANT_ID,
    );
    await _settleWebhookDeliveries();
    const fired = await sql<{ webhook_id: string }>`
      SELECT webhook_id::text AS webhook_id FROM zvd_webhook_deliveries
       WHERE webhook_id = ANY(${Object.values(ids)}::uuid[])
    `.execute(db);
    const names = Object.entries(ids)
      .filter(([, id]) => fired.rows.some((r) => r.webhook_id === id))
      .map(([name]) => name)
      .sort();
    expect(names).toEqual([
      'empty-collections',
      'named',
      'null-collections',
      'star-collections',
      'star-events',
    ]);
  });
});
