/**
 * Property/fuzz tests for the CRUD list query parser (H-10).
 *
 * parseFilters + decodeCursor turn hostile, user-shaped query strings into the
 * primitives the SQL builder consumes. The bug classes that live here are
 * operator injection (a client op that isn't in the canonical set reaching the
 * builder), column injection (a filter field outside the allowlist), and
 * crash-on-weird-input. These invariants must hold for ANY input, so we assert
 * them over hundreds of fast-check-generated cases rather than a few examples.
 */

import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { decodeCursor, parseFilters } from '../../lib/data/query-parse.js';

// The only ops parseFilters may ever emit — the values of OP_ALIAS. If a raw
// client op ever leaks through, it would appear here as something else.
const CANONICAL_OPS = new Set([
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'ilike',
  'in',
  'not_in',
  'null',
  'not_null',
]);

const RUNS = { numRuns: 600 };

describe('parseFilters — fuzz invariants', () => {
  const arbCols = fc
    .uniqueArray(fc.string())
    .map((a) => new Set<string>([...a, 'id', 'title', 'price']));
  const arbParams = fc.dictionary(fc.string(), fc.string());
  // Arbitrary strings (mostly garbage) + occasionally well-formed JSON.
  const arbFilterJson = fc.oneof(fc.string(), fc.json(), fc.constant(undefined));

  test('never throws on any input', () => {
    fc.assert(
      fc.property(arbParams, arbFilterJson, arbCols, (params, json, cols) => {
        parseFilters(params, json, cols);
        return true; // reaching here = no exception
      }),
      RUNS,
    );
  });

  test('output only ever contains canonical ops and allowlisted fields', () => {
    fc.assert(
      fc.property(arbParams, arbFilterJson, arbCols, (params, json, cols) => {
        const r = parseFilters(params, json, cols);
        if (!r.ok) {
          expect(typeof r.error).toBe('string');
          return true;
        }
        for (const [field, cond] of Object.entries(r.filters)) {
          // Column injection guard: every emitted field was allowlisted.
          expect(cols.has(field)).toBe(true);
          // Operator injection guard: never a raw client op.
          expect(CANONICAL_OPS.has(cond.op)).toBe(true);
        }
        return true;
      }),
      RUNS,
    );
  });

  test('round-trips a well-formed JSON filter on an allowed column', () => {
    const cols = new Set(['title', 'price', 'id']);
    fc.assert(
      fc.property(
        fc.constantFrom('title', 'price', 'id'),
        fc.constantFrom('eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'like', 'contains', 'ilike'),
        fc.oneof(fc.string(), fc.integer(), fc.boolean()),
        (field, clientOp, val) => {
          const r = parseFilters({}, JSON.stringify({ [field]: { [clientOp]: val } }), cols);
          expect(r.ok).toBe(true);
          if (r.ok) {
            expect(r.filters[field]).toBeDefined();
            expect(CANONICAL_OPS.has(r.filters[field].op)).toBe(true);
          }
          return true;
        },
      ),
      RUNS,
    );
  });

  test('an unknown field in JSON format is a typed 400, never a throw', () => {
    const cols = new Set(['title']);
    fc.assert(
      fc.property(
        fc.string().filter((s) => !cols.has(s) && s.length > 0),
        (unknownField) => {
          const r = parseFilters({}, JSON.stringify({ [unknownField]: { eq: 1 } }), cols);
          expect(r.ok).toBe(false);
          if (!r.ok) expect(r.error).toContain(unknownField);
          return true;
        },
      ),
      RUNS,
    );
  });
});

describe('decodeCursor — fuzz invariants', () => {
  test('never throws on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.base64String(), fc.constant(undefined)), (s) => {
        decodeCursor(s);
        return true;
      }),
      RUNS,
    );
  });

  test('output is null or a well-formed { id, val }', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.base64String()), (s) => {
        const r = decodeCursor(s);
        if (r !== null) {
          expect(typeof r.id).toBe('string');
          expect(r.id).toBeTruthy();
          expect(r.val).not.toBeUndefined();
        }
        return true;
      }),
      RUNS,
    );
  });

  test('round-trips a valid { id, val } through base64url', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => s.length > 0),
        fc.oneof(fc.string(), fc.integer(), fc.boolean()),
        (id, val) => {
          const cursor = Buffer.from(JSON.stringify({ id, val })).toString('base64url');
          const r = decodeCursor(cursor);
          expect(r).not.toBeNull();
          if (r) {
            expect(r.id).toBe(id);
            expect(r.val).toBe(val);
          }
          return true;
        },
      ),
      RUNS,
    );
  });
});
