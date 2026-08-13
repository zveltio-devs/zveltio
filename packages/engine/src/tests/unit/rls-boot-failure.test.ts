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
      override: false,
    });
    expect(reason).toBeString();
    expect(reason).toContain('zveltio_rls');
  });

  // The two working modes must not be swept up. `enforced` in particular is
  // the normal state of a superuser install, and failing it would make the
  // guard unshippable — which is how guards end up disabled everywhere.
  test.each(['enforced', 'native'] as const)('allows production in %s mode', (mode) => {
    expect(rlsBootFailure({ mode, nodeEnv: 'production', override: false })).toBeNull();
  });

  // A dev box on the stock postgres superuser is a normal thing to run.
  test.each([undefined, 'development', 'test'])('allows NODE_ENV=%s to start', (nodeEnv) => {
    expect(rlsBootFailure({ mode: 'unavailable', nodeEnv, override: false })).toBeNull();
  });

  test('honours the explicit single-tenant override', () => {
    expect(
      rlsBootFailure({ mode: 'unavailable', nodeEnv: 'production', override: true }),
    ).toBeNull();
  });
});
