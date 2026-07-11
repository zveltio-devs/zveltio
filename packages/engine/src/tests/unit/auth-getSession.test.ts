/**
 * getSession error classification (lib/auth.ts isBenignGetSessionError).
 */

import { describe, expect, it } from 'bun:test';
import { isBenignGetSessionError } from '../../lib/auth.js';

describe('isBenignGetSessionError', () => {
  it('treats APIError and BetterAuthError as benign', () => {
    expect(isBenignGetSessionError({ name: 'APIError', status: 401 })).toBe(true);
    expect(isBenignGetSessionError({ name: 'BetterAuthError', statusCode: 403 })).toBe(true);
  });

  it('treats 4xx status codes as benign cookie/session problems', () => {
    expect(isBenignGetSessionError({ status: 404 })).toBe(true);
    expect(isBenignGetSessionError({ statusCode: 422 })).toBe(true);
  });

  it('does not swallow 5xx or unknown errors', () => {
    expect(isBenignGetSessionError({ status: 500 })).toBe(false);
    expect(isBenignGetSessionError({ name: 'Error', message: 'db down' })).toBe(false);
  });
});
