import { describe, expect, it } from 'bun:test';
import { FieldTypeRegistry } from '../../lib/data/field-type-registry.js';
import { registerCoreFieldTypes } from '../../field-types/index.js';

// ADR 0054 spike: `integer` stored 9007199254740993 as ...992 and `decimal`
// kept 15 significant digits, because the write path ran `Number()` on them.
describe('numeric input keeps every digit', () => {
  const r = new FieldTypeRegistry();
  registerCoreFieldTypes(r);

  it('integer past 2^53 sent as a string reaches Postgres as that string', async () => {
    expect(await r.deserialize('integer', '9007199254740993')).toBe('9007199254740993');
  });
  it('decimal with more than 15 significant digits stays a string', async () => {
    expect(await r.deserialize('decimal', '12345678901234567.891')).toBe('12345678901234567.891');
    expect(await r.deserialize('number', '0.1234567890123456789')).toBe('0.1234567890123456789');
  });
  it('values a number holds exactly stay numbers (validation rules compare numbers)', async () => {
    expect(await r.deserialize('integer', '42')).toBe(42);
    expect(await r.deserialize('integer', 12.7)).toBe(12);
    expect(await r.deserialize('decimal', '1.50')).toBe(1.5);
    expect(await r.deserialize('decimal', '')).toBeNull();
  });
});
