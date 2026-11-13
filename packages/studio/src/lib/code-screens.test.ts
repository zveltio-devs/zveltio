import { describe, expect, test } from 'vitest';
import { codeScreen } from './code-screens.js';

describe('codeScreen', () => {
  test('names the page builder for its own extension only', () => {
    expect(codeScreen('content/pages', 'pages.builder')).toBeDefined();
    expect(codeScreen('crm', 'pages.builder')).toBeUndefined();
  });

  test('an extension-supplied id never reaches an inherited property', () => {
    for (const id of ['__proto__', 'constructor', 'toString', undefined]) {
      expect(codeScreen('content/pages', id)).toBeUndefined();
    }
  });
});
