/**
 * getSession error patch (lib/auth.ts wrapGetSession).
 */

import { describe, expect, it, spyOn } from 'bun:test';
import { wrapGetSession } from '../../lib/auth.js';

describe('wrapGetSession', () => {
  it('returns null for benign API/session errors', async () => {
    const wrapped = wrapGetSession(async (..._args: unknown[]) => {
      throw { name: 'APIError', status: 401 };
    });
    expect(await wrapped({ headers: new Headers() })).toBeNull();
  });

  it('rethrows unexpected errors after logging', async () => {
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const wrapped = wrapGetSession(async (..._args: unknown[]) => {
        throw new Error('database offline');
      });
      await expect(wrapped({})).rejects.toThrow('database offline');
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes('Unexpected error'))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('passes through successful sessions', async () => {
    const session = { user: { id: 'u1' } };
    const wrapped = wrapGetSession(async (..._args: unknown[]) => session);
    expect(await wrapped({})).toEqual(session);
  });
});
