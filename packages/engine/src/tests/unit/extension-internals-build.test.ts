/**
 * buildExtensionInternals (lib/extensions/internals.ts) — struct wiring + secret helpers.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';

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

describe('buildExtensionInternals', () => {
  it('exposes the expected helper bag keys', () => {
    const internals = buildExtensionInternals();
    expect(typeof internals.dynamicInsert).toBe('function');
    expect(typeof internals.enqueueDDLJob).toBe('function');
    expect(typeof internals.validatePublicUrl).toBe('function');
    expect(internals.extensionRegistry).toBeDefined();
  });

  it('encryptSecret / decryptSecret round-trip via field-crypto', async () => {
    const { encryptSecret, decryptSecret } = buildExtensionInternals();
    const enc = await encryptSecret('api-key-secret');
    expect(enc.startsWith('enc:v1:')).toBe(true);
    expect(await decryptSecret(enc)).toBe('api-key-secret');
    expect(await encryptSecret(enc)).toBe(enc);
    expect(await decryptSecret('plain')).toBe('plain');
  });
});
