/**
 * extension-context.ts hook helpers — extractSingleId + shouldFireHooks.
 */

import { describe, expect, it } from 'bun:test';
import { _internalForTests } from '../../lib/extensions/extension-context.js';

const { extractSingleId, shouldFireHooks } = _internalForTests;

describe('extension-context hook helpers', () => {
  it('shouldFireHooks is true only for zvd_ collection tables', () => {
    expect(shouldFireHooks('zvd_contacts')).toBe(true);
    expect(shouldFireHooks('zv_audit')).toBe(false);
    expect(shouldFireHooks('public_table')).toBe(false);
  });

  it('extractSingleId reads a single id = ? predicate', () => {
    expect(
      extractSingleId([{ method: 'where', args: ['id', '=', 'abc-123'] }]),
    ).toBe('abc-123');
    expect(extractSingleId([{ method: 'where', args: ['id', '=', 42] }])).toBe('42');
  });

  it('extractSingleId returns null for ambiguous chains', () => {
    expect(extractSingleId([])).toBeNull();
    expect(
      extractSingleId([
        { method: 'where', args: ['id', '=', 'a'] },
        { method: 'where', args: ['id', '=', 'b'] },
      ]),
    ).toBeNull();
    expect(extractSingleId([{ method: 'where', args: ['slug', '=', 'x'] }])).toBeNull();
  });
});
