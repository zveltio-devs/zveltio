/**
 * serializeRecord encrypted-field branch (lib/data/shape.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { registerCoreFieldTypes } from '../../field-types/index.js';
import { fieldTypeRegistry } from '../../lib/data/index.js';
import { serializeRecord } from '../../lib/data/shape.js';
import { encryptField } from '../../lib/data/field-crypto.js';

registerCoreFieldTypes(fieldTypeRegistry);

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
let savedKey: string | undefined;

beforeAll(() => {
  savedKey = process.env.FIELD_ENCRYPTION_KEY;
  process.env.FIELD_ENCRYPTION_KEY = KEY;
});
afterAll(() => {
  if (savedKey === undefined) delete process.env.FIELD_ENCRYPTION_KEY;
  else process.env.FIELD_ENCRYPTION_KEY = savedKey;
});

describe('serializeRecord — encrypted fields', () => {
  it('decrypts encrypted column values before field-type serialization', async () => {
    const cipher = await encryptField('secret-note');
    const out = await serializeRecord(
      { id: '1', note: cipher, search_vector: 'x' },
      {
        fields: [{ name: 'note', type: 'text', encrypted: true }],
      },
    );
    expect(out.note).toBe('secret-note');
    expect(out).not.toHaveProperty('search_vector');
  });

  it('passes plaintext through when encrypted flag is set but value is not ciphertext', async () => {
    const out = await serializeRecord(
      { id: '1', note: 'still-plain' },
      {
        fields: [{ name: 'note', type: 'text', encrypted: true }],
      },
    );
    expect(out.note).toBe('still-plain');
  });
});
