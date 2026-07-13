/**
 * webhooks.ts — delivery record insert failure + decrypted secret queue path.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import * as fieldCrypto from '../../lib/data/field-crypto.js';
import { _setCacheForTests } from '../../lib/runtime/cache.js';
import { WebhookManager } from '../../lib/webhooks.js';
import { CannedDb } from './fixtures/canned-db.js';

beforeEach(() => {
  _setCacheForTests(null);
});

afterEach(() => {
  _setCacheForTests(null);
  WebhookManager.init(null as unknown as Database);
});

describe('WebhookManager.trigger — delivery insert + secrets', () => {
  it('still queues when the delivery insert fails', async () => {
    const queued: string[] = [];
    _setCacheForTests({
      rpush: async (_key: string, payload: string) => {
        queued.push(payload);
      },
    } as never);

    const db = new CannedDb();
    db.when(/from zvd_webhooks/i, [
      {
        id: 'wh-no-del',
        url: 'https://hooks.example.com/no-del',
        method: 'POST',
        events: ['record.created'],
        collections: ['contacts'],
        retry_attempts: 1,
        secret: null,
      },
    ]);
    db.fail(/insert into "zvd_webhook_deliveries"/i, new Error('insert denied'));
    WebhookManager.init(db.kysely as unknown as Database);

    await WebhookManager.trigger('record.created', 'contacts', { id: 'r0' });
    expect(queued).toHaveLength(1);
    const payload = JSON.parse(queued[0]!) as { deliveryId: string | null };
    expect(payload.deliveryId).toBeNull();
  });

  it('queues decrypted plaintext secrets on Valkey', async () => {
    const decryptSpy = spyOn(fieldCrypto, 'maybeDecrypt').mockResolvedValue('plain-secret');
    const queued: string[] = [];
    _setCacheForTests({
      rpush: async (_key: string, payload: string) => {
        queued.push(payload);
      },
    } as never);

    const db = new CannedDb();
    db.when(/from zvd_webhooks/i, [
      {
        id: 'wh-plain',
        url: 'https://hooks.example.com/plain',
        method: 'POST',
        events: ['*'],
        collections: null,
        retry_attempts: 2,
        secret: 'enc:v1:abc',
      },
    ]);
    db.when(/insert into "zvd_webhook_deliveries"/i, [{ id: 'del-plain' }]);
    WebhookManager.init(db.kysely as unknown as Database);

    try {
      await WebhookManager.trigger('record.updated', 'contacts', { id: 'r3' });
      expect(queued).toHaveLength(1);
      const payload = JSON.parse(queued[0]!) as { secret: string | null };
      expect(payload.secret).toBe('plain-secret');
      expect(decryptSpy).toHaveBeenCalled();
    } finally {
      decryptSpy.mockRestore();
    }
  });
});
