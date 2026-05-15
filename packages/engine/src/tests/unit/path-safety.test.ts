import { describe, it, expect } from 'bun:test';
import { join, sep } from 'path';
import { isPathInsideBase } from '../../lib/extension-loader.js';

const ROOT = sep === '\\' ? 'C:\\Users\\zveltio\\extensions' : '/var/lib/zveltio/extensions';

describe('isPathInsideBase', () => {
  it('accepts a direct subdirectory', async () => {
    expect(await isPathInsideBase(ROOT, join(ROOT, 'forms'))).toBe(true);
  });

  it('accepts a deeply nested path', async () => {
    expect(await isPathInsideBase(ROOT, join(ROOT, 'auth', 'saml'))).toBe(true);
  });

  it('rejects the base itself', async () => {
    expect(await isPathInsideBase(ROOT, ROOT)).toBe(false);
  });

  it('rejects path-traversal escape', async () => {
    // join() resolves ".." so we craft the target manually.
    const escape = join(ROOT, '..', '..', 'etc');
    expect(await isPathInsideBase(ROOT, escape)).toBe(false);
  });

  it('rejects a sibling directory with the same prefix', async () => {
    // /var/lib/zveltio/extensions vs /var/lib/zveltio/extensions-evil
    expect(await isPathInsideBase(ROOT, ROOT + '-evil')).toBe(false);
  });

  it('rejects an unrelated absolute path', async () => {
    const unrelated = sep === '\\' ? 'D:\\elsewhere' : '/tmp/elsewhere';
    expect(await isPathInsideBase(ROOT, unrelated)).toBe(false);
  });
});
