/**
 * buildAllowedCols with JSON-string fields column (lib/data/query-parse.ts + shape.ts).
 */

import { describe, expect, it } from 'bun:test';
import { registerCoreFieldTypes } from '../../field-types/index.js';
import { fieldTypeRegistry } from '../../lib/data/field-type-registry.js';
import { buildAllowedCols } from '../../lib/data/query-parse.js';

describe('buildAllowedCols — JSON-string fields', () => {
  it('parses fields from a JSON-string column and merges system cols', () => {
    const cols = buildAllowedCols({
      fields: JSON.stringify([
        { name: 'title', type: 'text' },
        { name: 'score', type: 'integer' },
      ]),
    } as never);
    expect(cols.has('title')).toBe(true);
    expect(cols.has('score')).toBe(true);
    expect(cols.has('id')).toBe(true);
    expect(cols.has('created_at')).toBe(true);
  });

  it('leaves out a field whose type declares no filter operators', () => {
    if (!fieldTypeRegistry.get('password')) registerCoreFieldTypes(fieldTypeRegistry);
    const cols = buildAllowedCols({
      fields: [
        { name: 'title', type: 'text' },
        { name: 'secret', type: 'password' },
      ],
    } as never);
    expect(cols.has('title')).toBe(true);
    expect(cols.has('secret')).toBe(false);
  });
});
