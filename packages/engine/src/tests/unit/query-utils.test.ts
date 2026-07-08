/**
 * LIKE-escaping (lib/data/query-utils.ts) — turns user input into a literal for
 * a Postgres LIKE/ILIKE so `%`/`_` in a search term can't act as wildcards.
 */

import { describe, it, expect } from 'bun:test';
import { escapeLike } from '../../lib/data/query-utils.js';

describe('escapeLike', () => {
  it('escapes the % wildcard', () => {
    expect(escapeLike('50%')).toBe('50\\%');
  });

  it('escapes the _ single-char wildcard', () => {
    expect(escapeLike('a_b')).toBe('a\\_b');
  });

  it('escapes a literal backslash', () => {
    expect(escapeLike('a\\b')).toBe('a\\\\b');
  });

  it('leaves a plain string untouched', () => {
    expect(escapeLike('hello world')).toBe('hello world');
  });

  it('escapes all metacharacters together', () => {
    expect(escapeLike('%_\\')).toBe('\\%\\_\\\\');
  });
});
