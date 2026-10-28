import { describe, expect, it } from 'vitest';
import { cell, fromInput, inputKind, isWritable, toInput } from '@zveltio/ui/fields';

describe('workspace field mapping', () => {
  it('writes no relation, computed value or read-only column', () => {
    expect(isWritable({ type: 'text' })).toBe(true);
    expect(isWritable({ type: 'text', readonly: true })).toBe(false);
    for (const type of ['o2m', 'm2m', 'm2a', 'computed']) expect(isWritable({ type })).toBe(false);
  });

  it('sends an emptied input as null, not an empty string', () => {
    expect(fromInput(inputKind('integer'), '', 'qty')).toBeNull();
    expect(fromInput(inputKind('text'), '  ', 'title')).toBeNull();
    expect(fromInput(inputKind('date'), '', 'due')).toBeNull();
  });

  it('types numbers and JSON, and names the field it cannot read', () => {
    expect(fromInput('number', '4.5', 'qty')).toBe(4.5);
    expect(() => fromInput('number', 'four', 'qty')).toThrow('qty');
    expect(fromInput('json', '{"a":1}', 'meta')).toEqual({ a: 1 });
    expect(() => fromInput('json', '{a', 'meta')).toThrow('meta');
    expect(fromInput('checkbox', false, 'done')).toBe(false);
  });

  it('round-trips a timestamp through the local datetime input', () => {
    const stored = '2026-10-27T18:30:42.000Z';
    expect(fromInput('datetime-local', toInput('datetime-local', stored), 't')).toBe(stored);
  });

  it('shows objects as JSON and cuts long text', () => {
    expect(cell({ a: 1 })).toBe('{"a":1}');
    expect(cell(null)).toBe('');
    expect(cell('x'.repeat(100))).toHaveLength(80);
  });
});
