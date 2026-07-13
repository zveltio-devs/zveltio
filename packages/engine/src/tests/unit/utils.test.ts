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
});
