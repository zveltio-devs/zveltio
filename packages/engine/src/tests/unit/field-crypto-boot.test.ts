/**
 * field-crypto.ts — boot-time warning when encrypted fields exist without a key.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { checkFieldEncryptionAtBoot } from '../../lib/data/field-crypto.js';
import { CannedDb } from './fixtures/canned-db.js';

let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.FIELD_ENCRYPTION_KEY;
  delete process.env.FIELD_ENCRYPTION_KEY;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.FIELD_ENCRYPTION_KEY;
  else process.env.FIELD_ENCRYPTION_KEY = savedKey;
});

describe('checkFieldEncryptionAtBoot', () => {
  it('warns when collections declare encrypted fields but no key is set', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const db = new CannedDb();
    db.when(/from "zvd_collections"/i, [
      {
        name: 'contacts',
        fields: JSON.stringify([{ name: 'ssn', encrypted: true }]),
      },
    ]);
    try {
      await checkFieldEncryptionAtBoot(db.kysely as unknown as Database);
      expect(
        warn.mock.calls.some(
          (c) => String(c[0]).includes('contacts') && String(c[0]).includes('encrypted'),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('is a no-op when FIELD_ENCRYPTION_KEY is configured', async () => {
    process.env.FIELD_ENCRYPTION_KEY = 'a'.repeat(64);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const db = new CannedDb();
    db.when(/from "zvd_collections"/i, [
      { name: 'contacts', fields: JSON.stringify([{ name: 'ssn', encrypted: true }]) },
    ]);
    try {
      await checkFieldEncryptionAtBoot(db.kysely as unknown as Database);
      expect(warn.mock.calls).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('parses stringified fields JSON and ignores malformed entries', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const db = new CannedDb();
    db.when(/from "zvd_collections"/i, [
      { name: 'broken', fields: '{ not json' },
      {
        name: 'secrets',
        fields: JSON.stringify([{ name: 'token', encrypted: true }]),
      },
    ]);
    try {
      await checkFieldEncryptionAtBoot(db.kysely as unknown as Database);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('secrets'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
