/**
 * webhooks.ts — delivery outcome UPDATE rejection is swallowed (.catch).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { WebhookManager } from '../../lib/webhooks.js';
import { CannedDb } from './fixtures/canned-db.js';

const basePayload = {
  url: 'https://hooks.example.com/hook',
  event: 'record.created',
  collection: 'contacts',
  data: { id: 'r1' },
  timestamp: new Date().toISOString(),
};

beforeEach(() => {
  globalThis.fetch = (async () =>
    ({
      status: 200,
      ok: true,
      text: async () => '',
    }) as unknown as Response) as unknown as typeof fetch;
});

afterEach(() => {
  WebhookManager.init(null as unknown as Database);
});

describe('WebhookManager.deliver — delivery update rejection', () => {
  it('returns success even when the delivery UPDATE rejects', async () => {
    const db = new CannedDb();
    db.fail(/update "zvd_webhook_deliveries"/i, new Error('db write denied'));
    WebhookManager.init(db.kysely as unknown as Database);

    const ok = await WebhookManager.deliver({ ...basePayload, deliveryId: 'del-fail' });
    expect(ok).toBe(true);
    await new Promise((r) => setTimeout(r, 25));
    expect(db.executed(/update "zvd_webhook_deliveries"/i).length).toBe(1);
  });
});
