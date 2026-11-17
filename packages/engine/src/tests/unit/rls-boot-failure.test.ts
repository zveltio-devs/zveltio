import { describe, expect, test } from 'bun:test';
import { rlsBootFailure } from '../../lib/tenancy/tenant-manager.js';

/**
 * SEC-14. An install whose database cannot enforce tenant isolation used to
 * print a warning and serve traffic anyway — traffic written on the assumption
 * that one tenant cannot read another's rows.
 *
 * The mode this guards is `unavailable`, which means both halves failed at
 * once: the `zveltio_rls` role does not exist (so `withTenantIsolation` has
 * nothing to drop to) AND the connected role bypasses row-level security (so
 * FORCE ROW LEVEL SECURITY does not bind it either). Neither half alone is
 * this: `enforced` still isolates tenant requests through the role, and
 * `native` is already a plain role that RLS binds directly.
 */
describe('rlsBootFailure', () => {
  test('refuses production when isolation cannot be enforced', () => {
    const reason = rlsBootFailure({
      mode: 'unavailable',
      nodeEnv: 'production',
    });
    expect(reason).toBeString();
    expect(reason).toContain('zveltio_rls');
  });

  // The two working modes must not be swept up. `enforced` in particular is
  // the normal state of a superuser install, and failing it would make the
  // guard unshippable — which is how guards end up disabled everywhere.
  test.each(['enforced', 'native'] as const)('allows production in %s mode', (mode) => {
    expect(rlsBootFailure({ mode, nodeEnv: 'production' })).toBeNull();
  });

  // A dev box on the stock postgres superuser is a normal thing to run.
  test.each(['development', 'test'])('allows NODE_ENV=%s to start', (nodeEnv) => {
    expect(rlsBootFailure({ mode: 'unavailable', nodeEnv })).toBeNull();
  });

  // Unset is production (ADR 0058, owner 2026-11-17): a hand-started engine has none.
  test.each([undefined, '', 'staging'])('refuses NODE_ENV=%s', (nodeEnv) => {
    expect(rlsBootFailure({ mode: 'unavailable', nodeEnv })).toBeString();
  });

  // ADR 0058 d4: the single-tenant override is gone; setting it changes nothing.
  test('has no override: ZVELTIO_ALLOW_UNENFORCED_RLS=1 still refuses production', () => {
    process.env.ZVELTIO_ALLOW_UNENFORCED_RLS = '1';
    try {
      expect(rlsBootFailure({ mode: 'unavailable', nodeEnv: 'production' })).toBeString();
    } finally {
      delete process.env.ZVELTIO_ALLOW_UNENFORCED_RLS;
    }
  });
});
