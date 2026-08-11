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

  it('hands over the instance read policies, ungated', async () => {
    // An extension serving the same rows as a core route has to be able to
    // enforce the same rules. `ctx.db` carries the tenant boundary; the RLS
    // rules and column permissions an operator writes INSIDE a tenant are these
    // five, and without them `data/export` could not apply what `/api/export`
    // applies — the guard was unavailable, not forgotten.
    const internals = buildExtensionInternals();
    for (const name of [
      'getRlsFilters',
      'applyRlsFilters',
      'getColumnAccess',
      'resolveUserRole',
      'isTenantAdmin',
    ] as const) {
      expect(typeof internals[name]).toBe('function');
    }

    // Ungated on purpose: these only ever REMOVE rows and columns from a
    // result. Gating them would make the extension that declared no capability
    // the one that enforces nothing.
    const { INTERNALS_CAPABILITY } = await import('../../lib/extensions/capabilities.js');
    for (const name of ['getRlsFilters', 'getColumnAccess', 'isTenantAdmin']) {
      expect(INTERNALS_CAPABILITY[name]).toBeUndefined();
    }
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
