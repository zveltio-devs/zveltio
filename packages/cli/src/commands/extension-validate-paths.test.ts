// `extension validate` refuses the manifest paths the engine refuses at load
// (`manifestFile`, DR-TASKS l.58), so an author learns before publishing.
import { describe, expect, it } from 'bun:test';
import { _internalForTests } from './extension-validate.js';

const { outsideExtDir } = _internalForTests;

describe('extension validate: manifest paths stay in the extension directory', () => {
  it('refuses absolute paths and ".." segments', () => {
    for (const p of [
      '../x.json',
      'a/../../x.json',
      'a\\..\\x.json',
      '/etc/passwd',
      '',
      'a\0b',
      7,
    ]) {
      expect(outsideExtDir(p)).toBe(true);
    }
  });

  it('accepts relative paths under the directory', () => {
    for (const p of ['schemas/page.json', './engine/index.js', 'a..b/c.json']) {
      expect(outsideExtDir(p)).toBe(false);
    }
  });
});
