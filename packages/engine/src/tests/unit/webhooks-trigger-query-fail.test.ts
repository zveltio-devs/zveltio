/**
 * webhooks.ts — trigger() outer catch when the webhook query fails.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { WebhookManager } from '../../lib/webhooks.js';
import { CannedDb } from './fixtures/canned-db.js';

beforeEach(() => {
  WebhookManager.init(null as unknown as Database);
});

afterEach(() => {
  WebhookManager.init(null as unknown as Database);
});

describe('WebhookManager.trigger — query failure', () => {
  it('is a no-op when the webhook lookup query throws', async () => {
    const db = new CannedDb();
    db.fail(/from zvd_webhooks/i, new Error('connection reset'));
    WebhookManager.init(db.kysely as unknown as Database);

    await expect(
      WebhookManager.trigger('record.created', 'contacts', { id: 'r1' }),
    ).resolves.toBeUndefined();
  });
});
