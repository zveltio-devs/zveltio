/**
 * Property/fuzz tests for the CRUD list query parser (H-10).
 *
 * parseFilters + openCursor turn hostile, user-shaped query strings into the
 * primitives the SQL builder consumes. The bug classes that live here are
 * operator injection (a client op that isn't in the canonical set reaching the
 * builder), column injection (a filter field outside the allowlist), and
 * crash-on-weird-input. These invariants must hold for ANY input, so we assert
 * them over hundreds of fast-check-generated cases rather than a few examples.
 */

import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { openCursor, parseFilters, sealCursor } from '../../lib/data/query-parse.js';

process.env.BETTER_AUTH_SECRET ??= 'unit-test-secret-minimum-32-characters-long';
const BIND = { collection: 'zvd_t', sort: 'created_at', desc: true };

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
        for (const [field, conds] of Object.entries(r.filters)) {
          // Column injection guard: every emitted field was allowlisted.
          expect(cols.has(field)).toBe(true);
          // Operator injection guard: never a raw client op.
          for (const cond of [conds].flat()) expect(CANONICAL_OPS.has(cond.op)).toBe(true);
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
            expect(CANONICAL_OPS.has([r.filters[field]].flat()[0].op)).toBe(true);
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

/**
 * A cursor is base64url-encoded JSON, so the interesting inputs are the ones
 * that DECODE to valid JSON — and `fc.string()` / `fc.base64String()` produce
 * those only by accident. They never produced the six bytes that encode the
 * literal `null`, which is why this suite stayed green for 600 runs while
 * the cursor decoder threw a TypeError on it and the list route answered 500.
 *
 * Encoding the payload here puts the JSON literals inside the generator, so
 * "never throws" is an invariant the suite can actually falsify.
 */
const b64 = (raw: string) => Buffer.from(raw).toString('base64url');
const arbCursor = fc.oneof(
  fc.string(),
  fc.base64String(),
  // JSON that parses but is not a `{ id, val }` object — every one of these is a
  // malformed cursor and must take the offset fallback rather than throw.
  fc.constantFrom('null', 'true', 'false', '0', '123', '"str"', '[]', '[1,2]', '{}').map(b64),
  fc.jsonValue().map((v) => b64(JSON.stringify(v))),
);

describe('openCursor — fuzz invariants', () => {
  test('never throws on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.oneof(arbCursor, fc.constant(undefined)), (s) => {
        openCursor(s, BIND);
        return true;
      }),
      RUNS,
    );
  });

  test('a cursor the engine did not seal never opens to a position', () => {
    fc.assert(
      fc.property(arbCursor, (s) => {
        // None of these was sealed by the engine: every one is refused (the
        // start cursor names no row).
        const r = openCursor(s, BIND);
        expect(r === null || r === 'start').toBe(true);
        return true;
      }),
      RUNS,
    );
  });

  test('round-trips a sealed { id, val }, and only for the walk it was sealed for', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => s.length > 0),
        fc.oneof(fc.string(), fc.integer(), fc.boolean()),
        (id, val) => {
          const cursor = sealCursor({ id, val }, BIND);
          expect(openCursor(cursor, BIND)).toEqual({ id, val });
          expect(openCursor(cursor, { ...BIND, desc: false })).toBeNull();
          expect(openCursor(cursor, { ...BIND, sort: 'id' })).toBeNull();
          expect(openCursor(cursor, { ...BIND, collection: 'zvd_u' })).toBeNull();
          // A plaintext cursor of the same position, as before ADR 0021.
          expect(
            openCursor(Buffer.from(JSON.stringify({ id, val })).toString('base64url'), BIND),
          ).toBeNull();
          return true;
        },
      ),
      RUNS,
    );
  });
});
