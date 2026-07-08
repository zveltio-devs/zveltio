/**
 * GraphQL query-depth guard (lib/graphql-dataloader.ts) — a pure DoS protection
 * that rejects deeply-nested queries before they hit the resolver/DataLoader.
 */

import { describe, it, expect } from 'bun:test';
import { checkQueryDepth } from '../../lib/graphql-dataloader.js';

describe('checkQueryDepth', () => {
  it('allows a query within the default depth (5)', () => {
    expect(checkQueryDepth('{ user { posts { title } } }')).toBeNull();
    expect(checkQueryDepth('')).toBeNull();
  });

  it('rejects a query deeper than the limit', () => {
    const deep = '{'.repeat(6) + '}'.repeat(6); // depth 6 > 5
    expect(checkQueryDepth(deep)).toBe('Query exceeds maximum depth of 5');
  });

  it('honors a custom maxDepth', () => {
    expect(checkQueryDepth('{ a { b } }', 1)).toBe('Query exceeds maximum depth of 1');
    expect(checkQueryDepth('{ a { b } }', 2)).toBeNull(); // exactly at the limit
  });

  it('ignores braces inside string literals', () => {
    // The nested braces are inside a quoted value, so real depth is 1.
    expect(checkQueryDepth('{ note(eq: "a{b{c{d{e{f{") }')).toBeNull();
  });

  it('is not fooled by an escaped quote inside a string', () => {
    // The \" stays inside the string, so the trailing braces remain "in string".
    expect(checkQueryDepth('{ a(x: "he said \\"{{{{{{\\"") }')).toBeNull();
  });
});
