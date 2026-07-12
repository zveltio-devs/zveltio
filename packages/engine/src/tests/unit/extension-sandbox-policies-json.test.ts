/**
 * extension-sandbox.ts — EXTENSION_POLICIES_JSON parse failures.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { _internalForTests } from '../../lib/extensions/extension-sandbox.js';

describe('parsePolicyOverrides', () => {
  const saved = process.env.EXTENSION_POLICIES_JSON;

  afterEach(() => {
    if (saved === undefined) delete process.env.EXTENSION_POLICIES_JSON;
    else process.env.EXTENSION_POLICIES_JSON = saved;
  });

  it('returns {} when the env var is unset', () => {
    delete process.env.EXTENSION_POLICIES_JSON;
    expect(_internalForTests.parsePolicyOverrides()).toEqual({});
  });

  it('warns and returns {} when the env var is invalid JSON', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    process.env.EXTENSION_POLICIES_JSON = '{not-json';
    try {
      expect(_internalForTests.parsePolicyOverrides()).toEqual({});
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes('EXTENSION_POLICIES_JSON invalid JSON')),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('parses valid override JSON', () => {
    process.env.EXTENSION_POLICIES_JSON = JSON.stringify({
      'vendor/ext': { capabilities: ['db.read'], quotas: { routesMax: 10 } },
    });
    expect(_internalForTests.parsePolicyOverrides()['vendor/ext']?.capabilities).toEqual([
      'db.read',
    ]);
  });
});
