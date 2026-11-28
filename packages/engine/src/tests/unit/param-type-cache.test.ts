import { beforeEach, describe, expect, it } from 'bun:test';
import { clearParamTypeCache, paramTypes } from '../../db/bun-sql-dialect.js';

// The cache keys are whole statement texts: a count cap alone let a few
// thousand large generated texts hold tens of megabytes (DR-TASKS A08 low).
describe('paramTypes cache', () => {
  let asked = 0;
  const simple = async () => {
    asked++;
    return [undefined, [{ t: ['text'] }], undefined];
  };
  const big = (tag: string) => `select '${tag}' ${'-'.repeat(2_100_000)}`;

  beforeEach(() => {
    clearParamTypeCache();
    asked = 0;
  });

  it('answers a repeated text from the cache', async () => {
    await paramTypes('select $1', simple);
    expect(await paramTypes('select $1', simple)).toEqual(['text']);
    expect(asked).toBe(1);
  });

  it('evicts the oldest text once the character budget is spent', async () => {
    await paramTypes(big('a'), simple);
    await paramTypes(big('b'), simple); // a + b exceed the budget: a goes
    await paramTypes(big('b'), simple);
    expect(asked).toBe(2);
    await paramTypes(big('a'), simple);
    expect(asked).toBe(3);
  });

  it('answers but never keeps a text larger than the whole budget', async () => {
    const huge = `select ${'-'.repeat(4_000_001)}`;
    await paramTypes(huge, simple);
    await paramTypes(huge, simple);
    expect(asked).toBe(2);
  });
});
