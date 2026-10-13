/**
 * utils.ts — generateId (nanoid replacement).
 */

import { describe, expect, it } from 'bun:test';
import { generateId } from '../../lib/utils.js';

describe('generateId', () => {
  it('returns a 21-character URL-safe id by default', () => {
    const id = generateId();
    expect(id).toHaveLength(21);
    expect(id).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('honours a custom length', () => {
    const id = generateId(8);
    expect(id).toHaveLength(8);
  });

  it('generates distinct values', () => {
    const a = generateId();
    const b = generateId();
    expect(a).not.toBe(b);
  });

  it('drops bytes at or above 248 instead of folding them onto the first characters', () => {
    const real = crypto.getRandomValues;
    let call = 0;
    // First draw is all 248 (would be 'A' under `byte % 62`), second all 1.
    crypto.getRandomValues = (<T extends ArrayBufferView>(a: T): T => {
      (a as unknown as Uint8Array).fill(call++ === 0 ? 248 : 1);
      return a;
    }) as typeof crypto.getRandomValues;
    try {
      expect(generateId(4)).toBe('BBBB');
    } finally {
      crypto.getRandomValues = real;
    }
  });
});
