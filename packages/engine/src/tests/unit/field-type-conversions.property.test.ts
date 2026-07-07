/**
 * Property/fuzz tests for the field-type conversion strategy (H-10).
 *
 * resolveConversion decides whether an `ALTER COLUMN ... TYPE` is allowed and
 * emits the USING clause the DDL layer runs. Bug classes here: a malformed
 * result shape reaching the DDL builder, a USING clause that forgets to quote
 * the column, a silent type swap, or a crash on an unexpected type key. These
 * invariants must hold for ANY (from, to, sqlType, column) tuple, so we assert
 * them over hundreds of fast-check cases.
 */

import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { resolveConversion } from '../../lib/data/field-type-conversions.js';

// The field-type keys the registry knows, plus the relation types that must
// always be refused, plus a few nonsense keys to probe the generic fallback.
const KNOWN_TYPES = [
  'text',
  'longtext',
  'richtext',
  'email',
  'url',
  'integer',
  'bigint',
  'decimal',
  'float',
  'number',
  'boolean',
  'date',
  'datetime',
  'json',
  'jsonb',
  'm2o',
  'o2m',
  'm2m',
  'reference',
];
const RELATION_TYPES = ['m2o', 'o2m', 'm2m', 'reference'];
const arbType = fc.oneof(fc.constantFrom(...KNOWN_TYPES), fc.string());
const RUNS = { numRuns: 600 };

describe('resolveConversion — fuzz invariants', () => {
  test('never throws on arbitrary type/column strings', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), fc.string(), (from, to, sqlType, col) => {
        resolveConversion(from, to, sqlType, col);
        return true;
      }),
      RUNS,
    );
  });

  test('result is always a well-formed ConversionResult', () => {
    fc.assert(
      fc.property(
        arbType,
        arbType,
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        (from, to, sqlType, col) => {
          const r = resolveConversion(from, to, sqlType, col);
          if (r.ok) {
            // The target SQL type is passed through verbatim — never swapped.
            expect(r.sqlType).toBe(sqlType);
            // When a USING clause is emitted it must quote the column, never
            // splice a bare identifier into SQL.
            if (r.using !== undefined) expect(r.using).toContain(`"${col}"`);
          } else {
            expect(typeof r.reason).toBe('string');
            expect(r.reason.length).toBeGreaterThan(0);
          }
          return true;
        },
      ),
      RUNS,
    );
  });

  test('a no-op conversion (identical types) is always refused', () => {
    fc.assert(
      fc.property(arbType, fc.string({ minLength: 1 }), (t, col) => {
        expect(resolveConversion(t, t, 'TEXT', col).ok).toBe(false);
        return true;
      }),
      RUNS,
    );
  });

  test('any conversion touching a relation type is always refused', () => {
    fc.assert(
      fc.property(fc.constantFrom(...RELATION_TYPES), arbType, (rel, other) => {
        if (rel === other) return true; // identical-type refusal covered elsewhere
        expect(resolveConversion(rel, other, 'TEXT', 'c').ok).toBe(false);
        expect(resolveConversion(other, rel, 'TEXT', 'c').ok).toBe(false);
        return true;
      }),
      RUNS,
    );
  });
});
