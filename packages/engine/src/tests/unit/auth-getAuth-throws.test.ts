/**
 * getAuth before initAuth (lib/auth.ts).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { _internalForTests, getAuth } from '../../lib/auth.js';

afterEach(() => {
  _internalForTests.resetAuthModuleForTests();
});

describe('getAuth', () => {
  it('throws when auth has not been initialized', () => {
    expect(() => getAuth()).toThrow('Auth not initialized');
  });
});
