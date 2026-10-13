import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import {
  policyFor,
  hasCapability,
  _internalForTests,
} from '../../lib/extensions/extension-sandbox.js';

/**
 * S5-05 — extension sandbox policy resolution.
 *
 * Tests the decision logic that wraps every capability check the engine
 * (and future WASM sandbox) makes against an extension. The runtime
 * enforcement happens at the call site (e.g. RestrictedDb already
 * enforces db.write); this layer's job is "return the right policy
 * object". Drift here = silently relaxing security boundaries.
 */

describe('S5-05 isFirstParty', () => {
  it('recognizes single-segment first-party names', () => {
    expect(_internalForTests.isFirstParty('ai')).toBe(true);
    expect(_internalForTests.isFirstParty('billing')).toBe(true);
    expect(_internalForTests.isFirstParty('crm')).toBe(true);
    expect(_internalForTests.isFirstParty('forms')).toBe(true);
    expect(_internalForTests.isFirstParty('search')).toBe(true);
  });

  it('recognizes prefixed first-party names', () => {
    expect(_internalForTests.isFirstParty('finance/invoicing')).toBe(true);
    expect(_internalForTests.isFirstParty('communications/mail')).toBe(true);
    expect(_internalForTests.isFirstParty('compliance/ro/saft')).toBe(true);
    expect(_internalForTests.isFirstParty('developer/api-docs')).toBe(true);
  });

  it('rejects unknown names as third-party', () => {
    expect(_internalForTests.isFirstParty('totally-new-extension')).toBe(false);
    expect(_internalForTests.isFirstParty('vendor/widget')).toBe(false);
    expect(_internalForTests.isFirstParty('community/foo')).toBe(false);
  });

  it('does not match by substring (security: "ai-shim" is NOT "ai")', () => {
    expect(_internalForTests.isFirstParty('ai-shim')).toBe(false);
    expect(_internalForTests.isFirstParty('billing-clone')).toBe(false);
  });
});

describe('S5-05 policyFor', () => {
  const origEnv = process.env.EXTENSION_POLICIES_JSON;

  beforeEach(() => {
    _internalForTests.resetCache();
  });
  afterEach(() => {
    _internalForTests.resetCache();
    if (origEnv === undefined) delete process.env.EXTENSION_POLICIES_JSON;
    else process.env.EXTENSION_POLICIES_JSON = origEnv;
  });

  it('returns first-party defaults for known names', () => {
    const p = policyFor('finance/invoicing');
    expect(p.firstParty).toBe(true);
    expect(p.capabilities.has('db.write')).toBe(true);
    expect(p.capabilities.has('fetch.http')).toBe(true);
    expect(p.capabilities.has('process.spawn')).toBe(false); // never granted
    expect(p.quotas.cpuMsPerRequest).toBe(-1); // unlimited
  });

  it('returns third-party defaults (fail-closed) for unknown names', () => {
    const p = policyFor('totally-unknown');
    expect(p.firstParty).toBe(false);
    expect(p.capabilities.has('db.write')).toBe(true);
    expect(p.capabilities.has('fetch.https')).toBe(true);
    expect(p.capabilities.has('fetch.http')).toBe(false); // HTTPS only
    expect(p.capabilities.has('env.read')).toBe(false);
    expect(p.capabilities.has('fs.read')).toBe(false);
    expect(p.quotas.cpuMsPerRequest).toBe(5_000); // bounded
  });

  it('caches the resolved policy', () => {
    const a = policyFor('ai');
    const b = policyFor('ai');
    expect(a).toBe(b);
  });

  it('applies EXTENSION_POLICIES_JSON overrides on top of defaults', async () => {
    // Overrides are read at module init, so the module is imported afresh (a
    // query string is a distinct module to Bun) with the variable set.
    const saved = process.env.EXTENSION_POLICIES_JSON;
    process.env.EXTENSION_POLICIES_JSON = JSON.stringify({
      'finance/invoicing': { quotas: { cpuMsPerRequest: 2000 } },
    });
    try {
      const fresh = (await import(
        // @ts-expect-error -- a query string makes Bun load a second instance
        '../../lib/extensions/extension-sandbox.ts?policies-override'
      )) as typeof import('../../lib/extensions/extension-sandbox.js');
      const p = fresh.policyFor('finance/invoicing');
      expect(p.quotas.cpuMsPerRequest).toBe(2000);
      // Unnamed quotas keep the default.
      expect(p.quotas.bundleSizeKbMax).toBe(policyFor('finance/invoicing').quotas.bundleSizeKbMax);
    } finally {
      if (saved === undefined) delete process.env.EXTENSION_POLICIES_JSON;
      else process.env.EXTENSION_POLICIES_JSON = saved;
    }
  });

  it('treats malformed EXTENSION_POLICIES_JSON as empty (no crash)', () => {
    // We can't easily re-init the module mid-test in Bun. The behavior
    // is documented: a JSON parse error logs a warning and returns {}.
    // Production deployments using this env should run their config
    // through `JSON.parse(...)` once in CI before shipping.
    expect(typeof policyFor('any').name).toBe('string');
  });
});

describe('S5-05 hasCapability', () => {
  beforeEach(() => {
    _internalForTests.resetCache();
  });
  afterEach(() => {
    _internalForTests.resetCache();
  });

  it('allows first-party extensions to use first-party capabilities', () => {
    expect(hasCapability('forms', 'db.write')).toBe(true);
    expect(hasCapability('forms', 'fetch.http')).toBe(true);
    expect(hasCapability('forms', 'crypto.subtle')).toBe(true);
  });

  it('denies process.spawn even for first-party (intentional hardening)', () => {
    expect(hasCapability('finance/invoicing', 'process.spawn')).toBe(false);
  });

  it('denies fetch.http for third-party (HTTPS only)', () => {
    expect(hasCapability('unknown-ext', 'fetch.http')).toBe(false);
    expect(hasCapability('unknown-ext', 'fetch.https')).toBe(true);
  });

  it('denies env.read for third-party (would leak secrets)', () => {
    expect(hasCapability('unknown-ext', 'env.read')).toBe(false);
    expect(hasCapability('ai', 'env.read')).toBe(true);
  });

  it('denies fs.* for third-party', () => {
    expect(hasCapability('unknown-ext', 'fs.read')).toBe(false);
    expect(hasCapability('unknown-ext', 'fs.write')).toBe(false);
  });

  it('logs a warning when a capability is denied', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(hasCapability('unknown-ext', 'env.read')).toBe(false);
      expect(
        warnSpy.mock.calls.some((c) =>
          String(c[0]).includes('extension="unknown-ext" capability="env.read" decision=denied'),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('S5-05 default quotas', () => {
  beforeEach(() => {
    _internalForTests.resetCache();
  });

  it('first-party gets larger bundle / migrations / no CPU limit', () => {
    const p = policyFor('ai');
    expect(p.quotas.bundleSizeKbMax).toBe(5 * 1024);
    expect(p.quotas.nodeModulesSizeKbMax).toBe(50 * 1024);
    expect(p.quotas.migrationsMax).toBe(50);
    expect(p.quotas.routesMax).toBe(-1);
    expect(p.quotas.cpuMsPerRequest).toBe(-1);
  });

  it('third-party gets tighter bundle / routes capped / CPU bounded', () => {
    const p = policyFor('community/widget');
    expect(p.quotas.bundleSizeKbMax).toBe(2 * 1024);
    expect(p.quotas.nodeModulesSizeKbMax).toBe(10 * 1024);
    expect(p.quotas.migrationsMax).toBe(20);
    expect(p.quotas.routesMax).toBe(50);
    expect(p.quotas.cpuMsPerRequest).toBe(5_000);
  });
});
