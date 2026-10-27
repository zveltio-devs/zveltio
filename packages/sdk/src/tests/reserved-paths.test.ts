import { describe, expect, it } from 'bun:test';
import { isReservedPath } from '../extension/index.js';

describe('isReservedPath', () => {
  it('refuses a path whose first segment the engine or the App owns', () => {
    for (const p of [
      'admin',
      '/admin',
      'app/crm',
      '/API/x',
      'auth',
      '.well-known/x',
      'favicon.ico',
      'robots.txt',
    ])
      expect(isReservedPath(p)).toBe(true);
  });
  it('accepts a path that only starts with the same letters', () => {
    for (const p of ['apps', 'about', 'administrator', 'blog/admin', '', '/'])
      expect(isReservedPath(p)).toBe(false);
  });
});
