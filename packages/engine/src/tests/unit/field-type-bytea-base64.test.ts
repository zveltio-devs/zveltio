import { describe, expect, it } from 'bun:test';
import { FieldTypeRegistry } from '../../lib/data/field-type-registry.js';
import { registerCoreFieldTypes } from '../../field-types/index.js';

// ADR 0054 spike: a base64 `bytea` value was stored as its ASCII bytes, and a
// read answered `{"type":"Buffer","data":[...]}`. Base64 both ways now.
describe('bytea is base64 both ways', () => {
  const r = new FieldTypeRegistry();
  registerCoreFieldTypes(r);
  const field = { name: 'b', type: 'bytea' } as never;

  it('a base64 string is written as the bytes it encodes', async () => {
    expect([...((await r.deserialize('bytea', 'AAH+/w==')) as Buffer)]).toEqual([0, 1, 254, 255]);
  });
  it('what the driver reads (a Buffer) is answered as base64', () => {
    expect(r.serialize('bytea', Buffer.from([0, 1, 254, 255]))).toBe('AAH+/w==');
  });
  it('a string that is not base64 is refused', () => {
    expect(r.validate('bytea', 'not base64!', field)).toBe('Must be base64');
    expect(r.validate('bytea', 'abc', field)).toBe('Must be base64');
    expect(r.validate('bytea', 'aGk=', field)).toBeNull();
  });
});
