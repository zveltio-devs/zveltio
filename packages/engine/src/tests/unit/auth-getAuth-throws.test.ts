/**
 * getAuth before initAuth (lib/auth.ts).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { _internalForTests, getAuth } from '../../lib/auth.js';

// `_auth` is a module-global singleton shared across every test file in the run,
// and several files call initAuth(). Resetting only in afterEach left this test
// order-dependent: if an initAuth() file ran first, getAuth() no longer threw.
// Reset BEFORE too, so the assertion starts from a genuinely uninitialized module.
beforeEach(() => {
  _internalForTests.resetAuthModuleForTests();
});
afterEach(() => {
  _internalForTests.resetAuthModuleForTests();
});

describe('getAuth', () => {
  it('throws when auth has not been initialized', () => {
    expect(() => getAuth()).toThrow('Auth not initialized');
  });
});
