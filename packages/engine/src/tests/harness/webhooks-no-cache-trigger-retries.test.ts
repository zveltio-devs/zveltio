/**
 * That `trigger` is WIRED to the retrying path, not merely that the retrying
 * path exists.
 *
 * `_deliverWithRetries` has its own unit coverage, and that coverage stays
 * green when `trigger` calls plain `deliver` instead — the exact shape of a
 * test that passes for the wrong reason. This one goes through `trigger` on the
 * no-cache branch and counts the requests that actually left.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import { WebhookManager, _settleWebhookDeliveries } from '../../lib/webhooks.js';
import { getCache } from '../../lib/runtime/index.js';
import { DEFAULT_TENANT_ID } from '../../lib/route-db.js';

const d = harnessAvailable() ? describe : describe.skip;
const WEBHOOK_ID = '00000000-0000-4000-8000-0000000000f1';
const STAMP = Date.now();
// Unique to this file: other harness files leave active `*` webhooks in the
// default tenant, and settling would wait out THEIR retry backoffs too.
const COLLECTION = `nocache_${STAMP}`;

d('trigger retries on the no-cache path (in-process)', () => {
  let db: Database;
  let originalFetch: typeof fetch;
  let hits = 0;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    WebhookManager.init(db);
    await db
      .insertInto('zvd_webhooks')
      .values({
        id: WEBHOOK_ID,
        name: `nocache-${STAMP}`,
        url: 'https://example.com/nocache',
        method: 'POST',
        events: ['*'] as unknown as string[],
        collections: [COLLECTION] as unknown as string[],
        active: true,
        secret: null,
        // One retry: the backoff is real (1s) and this keeps the test honest
        // without making it slow.
        retry_attempts: 1,
        timeout: 5000,
        tenant_id: DEFAULT_TENANT_ID,
      } as never)
      .execute();
  });

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .deleteFrom('zvd_webhook_deliveries')
      .where('webhook_id', '=', WEBHOOK_ID)
      .execute()
      .catch(() => {});
    await db
      .deleteFrom('zvd_webhooks')
      .where('id', '=', WEBHOOK_ID)
      .execute()
      .catch(() => {});
  });

  it('sends more than once when the endpoint keeps failing', async () => {
    // The branch under test only exists when there is no cache to queue into.
    expect(getCache()).toBeNull();

    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      hits++;
      return { status: 500, ok: false, text: async () => '' } as Response;
    }) as unknown as typeof fetch;

    // `_inFlight` is module state shared by every file in this bun process, and
    // `_settleWebhookDeliveries` waits for ALL of it. Earlier harness files
    // leave deliveries running, and now that a cache-less delivery RETRIES,
    // those leftovers live for their whole backoff — so settling below would
    // wait them out and blow the deadline even though this file's own delivery
    // finished. Drain them first, against the stub so they fail fast, and only
    // then start counting.
    await _settleWebhookDeliveries();
    hits = 0;

    await WebhookManager.trigger(
      'insert',
      COLLECTION,
      { id: '00000000-0000-4000-8000-0000000000f2' },
      DEFAULT_TENANT_ID,
    );
    await _settleWebhookDeliveries();

    expect(hits).toBe(2); // the first try plus the one retry
    // Generous, and deliberately not a race: the drain above plus this file's
    // own 1s backoff take seconds, and nothing here is asserted on a clock.
  }, 60_000);
});
