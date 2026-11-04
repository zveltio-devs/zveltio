import { describe, expect, it } from 'vitest';
import { fillUrl } from './fill-url.js';

describe('fillUrl', () => {
  const row: Record<string, unknown> = { id: 'a&b#c', name: 'x/../../api/users', n: 3, none: null };
  const get = (k: string) => row[k];

  it('encodes each value, so it stays one segment or query value', () => {
    expect(fillUrl('/api/data/t/{id}?q={name}', get)).toBe(
      '/api/data/t/a%26b%23c?q=x%2F..%2F..%2Fapi%2Fusers',
    );
  });

  it('fills numbers, and nothing for an absent value', () => {
    expect(fillUrl('/x/{n}/{none}/{missing}', get)).toBe('/x/3//');
  });
});
