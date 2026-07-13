/**
 * webhooks.ts — Valkey queue path + encrypted secret decrypt failure.
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

describe('WebhookManager.trigger — cache + secrets', () => {
  it('queues payloads on Valkey when a cache backend is configured', async () => {
    const queued: string[] = [];
    _setCacheForTests({
      rpush: async (_key: string, payload: string) => {
        queued.push(payload);
      },
    } as never);

    const db = new CannedDb();
    db.when(/from zvd_webhooks/i, [
      {
        id: 'wh-cache',
        url: 'https://hooks.example.com/queued',
        method: 'POST',
        events: ['record.created'],
        collections: ['contacts'],
        retry_attempts: 2,
        secret: null,
      },
    ]);
    db.when(/insert into "zvd_webhook_deliveries"/i, [{ id: 'del-q' }]);
    WebhookManager.init(db.kysely as unknown as Database);

    await WebhookManager.trigger('record.created', 'contacts', { id: 'r9' });

    expect(queued).toHaveLength(1);
    const payload = JSON.parse(queued[0]!) as { webhookId: string; deliveryId: string };
    expect(payload.webhookId).toBe('wh-cache');
    expect(payload.deliveryId).toBe('del-q');
  });

  it('warns and omits the secret when decrypt fails', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const decryptSpy = spyOn(fieldCrypto, 'maybeDecrypt').mockRejectedValue(
      new Error('bad ciphertext'),
    );

    const db = new CannedDb();
    db.when(/from zvd_webhooks/i, [
      {
        id: 'wh-enc',
        url: 'https://hooks.example.com/enc',
        method: 'POST',
        events: ['*'],
        collections: null,
        retry_attempts: 3,
        secret: 'enc:v1:deadbeef',
      },
    ]);
    db.when(/insert into "zvd_webhook_deliveries"/i, [{ id: 'del-enc' }]);
    WebhookManager.init(db.kysely as unknown as Database);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ status: 200, ok: true, text: async () => '' })) as never;

    try {
      await WebhookManager.trigger('record.updated', 'contacts', { id: 'r1' });
      await new Promise((r) => setTimeout(r, 50));
      expect(
        warn.mock.calls.some((c) =>
          String(c[0]).includes('failed to decrypt secret for webhook wh-enc'),
        ),
      ).toBe(true);
      expect(decryptSpy).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      warn.mockRestore();
      decryptSpy.mockRestore();
    }
  });

  it('omits the secret when decrypt returns a non-string value', async () => {
    const decryptSpy = spyOn(fieldCrypto, 'maybeDecrypt').mockResolvedValue({ not: 'string' });
    const queued: string[] = [];
    _setCacheForTests({
      rpush: async (_key: string, payload: string) => {
        queued.push(payload);
      },
    } as never);

    const db = new CannedDb();
    db.when(/from zvd_webhooks/i, [
      {
        id: 'wh-nonstring',
        url: 'https://hooks.example.com/ns',
        method: 'POST',
        events: ['*'],
        collections: null,
        retry_attempts: 1,
        secret: 'enc:v1:abc',
      },
    ]);
    db.when(/insert into "zvd_webhook_deliveries"/i, [{ id: 'del-ns' }]);
    WebhookManager.init(db.kysely as unknown as Database);

    try {
      await WebhookManager.trigger('record.created', 'contacts', { id: 'r2' });
      expect(queued).toHaveLength(1);
      const payload = JSON.parse(queued[0]!) as { secret: string | null };
      expect(payload.secret).toBeNull();
      expect(decryptSpy).toHaveBeenCalled();
    } finally {
      decryptSpy.mockRestore();
    }
  });

  it('matches collection-scoped webhooks via the collections array', async () => {
    const db = new CannedDb();
    db.when(/from zvd_webhooks/i, [
      {
        id: 'wh-scoped',
        url: 'https://hooks.example.com/scoped',
        method: 'POST',
        events: ['record.created'],
        collections: ['orders'],
        retry_attempts: 1,
      },
    ]);
    WebhookManager.init(db.kysely as unknown as Database);

    let hit = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      if (String(url) === 'https://hooks.example.com/scoped') hit = true;
      return { status: 200, ok: true, text: async () => '' } as Response;
    }) as typeof fetch;

    try {
      await WebhookManager.trigger('record.created', 'orders', { id: 'o1' });
      await new Promise((r) => setTimeout(r, 50));
      expect(hit).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
