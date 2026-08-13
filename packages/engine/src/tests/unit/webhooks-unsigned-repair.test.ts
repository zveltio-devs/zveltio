import { beforeAll, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { repairUnsignedWebhooksAtBoot } from '../../lib/webhooks.js';
import { CannedDb } from './fixtures/canned-db.js';

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

/**
 * Webhooks created before alpha.32 have `secret = NULL`, and the delivery path
 * signs conditionally — so they post unsigned payloads that a receiver cannot
 * distinguish from anyone else who learned the URL. Nothing reported it: the
 * deliveries succeed, and an absent signature header is not an error to either
 * side.
 */
describe('repairUnsignedWebhooksAtBoot', () => {
  // The secret column is an `encrypted: true` field, so the repair cannot run
  // without a key — a real install has one, and a test that omitted it was
  // measuring the refusal rather than the repair.
  beforeAll(() => {
    process.env.FIELD_ENCRYPTION_KEY ??= 'a'.repeat(64);
  });

  it('gives an unsigned webhook a secret and says which one it was', async () => {
    const db = new CannedDb();
    db.when(/FROM zvd_webhooks/i, [{ id: 'w1', name: 'legacy-hook' }]);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await repairUnsignedWebhooksAtBoot(asDb(db))).toBe(1);
      // Asserted before mockRestore(), which discards the recorded calls.
      // Naming the webhook is the point of the warning — the operator has to go
      // and configure the receiver, and cannot do that from a count.
      expect(warn.mock.calls.some((c) => String(c[0]).includes('legacy-hook'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
    expect(db.executed(/UPDATE zvd_webhooks/i)).toHaveLength(1);
  });

  it('writes nothing when every webhook is already signed', async () => {
    const db = new CannedDb();
    db.when(/FROM zvd_webhooks/i, []);
    expect(await repairUnsignedWebhooksAtBoot(asDb(db))).toBe(0);
    expect(db.executed(/UPDATE zvd_webhooks/i)).toHaveLength(0);
  });

  it('says the webhooks stay unsigned when no key is available to store a secret', async () => {
    const db = new CannedDb();
    db.when(/FROM zvd_webhooks/i, [{ id: 'w1', name: 'legacy-hook' }]);
    const saved = process.env.FIELD_ENCRYPTION_KEY;
    delete process.env.FIELD_ENCRYPTION_KEY;
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await repairUnsignedWebhooksAtBoot(asDb(db))).toBe(0);
      // The point: the message has to name the consequence, not just the cause.
      // "could not repair" reads as a hiccup; this install is still delivering
      // forgeable payloads and the operator has to know that from one line.
      expect(warn.mock.calls.some((c) => /unsigned payloads/.test(String(c[0])))).toBe(true);
    } finally {
      warn.mockRestore();
      if (saved !== undefined) process.env.FIELD_ENCRYPTION_KEY = saved;
    }
    expect(db.executed(/UPDATE zvd_webhooks/i)).toHaveLength(0);
  });

  it('does not take the engine down when the repair fails', async () => {
    const db = new CannedDb();
    db.fail(/FROM zvd_webhooks/i, new Error('relation "zvd_webhooks" does not exist'));
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await repairUnsignedWebhooksAtBoot(asDb(db))).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});
