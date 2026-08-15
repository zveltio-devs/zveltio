import { describe, expect, it } from 'bun:test';
import * as sdk from '@zveltio/sdk/extension';
import {
  NumericConversionError,
  isStorableNumeric,
  roundMoney,
  sumNumeric,
  toNumber,
  toNumberOrNull,
  toNumberSafe,
} from '../../lib/numeric.js';

/**
 * The values in these tests are the ones the driver actually produced against
 * PostgreSQL 18, not invented ones: BIGINT, NUMERIC, DECIMAL and every
 * COUNT/SUM/AVG aggregate arrive as strings.
 */
describe('toNumber', () => {
  it('converts what the driver delivers for a numeric column', () => {
    expect(toNumber('1234.56')).toBe(1234.56);
    expect(toNumber('9007199254740992')).toBe(9007199254740992);
    expect(toNumber('0')).toBe(0);
    expect(toNumber('-7.5')).toBe(-7.5);
    expect(toNumber(42)).toBe(42);
  });

  it('substitutes only for absent values, and only with what the caller asked for', () => {
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
    expect(toNumber(null, 5_368_709_120)).toBe(5_368_709_120);
  });

  // The whole point. A `?? 0` here is what lets a corrupt row look like a
  // legitimate zero, and PostgreSQL has already accepted NaN into the column by
  // the time anyone notices.
  it('refuses a value that is not a finite number rather than inventing one', () => {
    expect(() => toNumber(Number.NaN)).toThrow(NumericConversionError);
    expect(() => toNumber('NaN')).toThrow(NumericConversionError);
    expect(() => toNumber(Number.POSITIVE_INFINITY)).toThrow(NumericConversionError);
    expect(() => toNumber('not a number')).toThrow(NumericConversionError);
    expect(() => toNumber({})).toThrow(NumericConversionError);
  });

  it('refuses the empty string, which Number() would call zero', () => {
    // `Number('')` is 0 and `Number('   ')` is 0. A column that came back empty
    // is a column something is wrong with, not a column holding nothing.
    expect(() => toNumber('')).toThrow(NumericConversionError);
    expect(() => toNumber('   ')).toThrow(NumericConversionError);
  });

  it('refuses a bigint that cannot round-trip through a double', () => {
    expect(toNumber(123n)).toBe(123);
    expect(() => toNumber(9007199254740993n)).toThrow(NumericConversionError);
  });

  it('names the column in the message, so the log says where to look', () => {
    expect(() => toNumber('NaN', 0, 'zvd_leave_balances.carried_over_days')).toThrow(
      /zvd_leave_balances\.carried_over_days/,
    );
  });
});

describe('toNumberOrNull', () => {
  it('keeps absent distinct from zero', () => {
    expect(toNumberOrNull(null)).toBeNull();
    expect(toNumberOrNull('0')).toBe(0);
  });
});

describe('toNumberSafe', () => {
  it('answers the fallback instead of throwing, for display paths only', () => {
    expect(toNumberSafe('NaN', -1)).toBe(-1);
    expect(toNumberSafe('12.5', -1)).toBe(12.5);
  });
});

describe('sumNumeric', () => {
  it('adds a column across rows without concatenating it', () => {
    const rows = [{ amount: '10.50' }, { amount: '4.50' }, { amount: '0' }];
    expect(sumNumeric(rows, (r) => r.amount)).toBe(15);
    // What the code under repair was doing instead. The values are what the
    // driver hands over for a NUMERIC column, so this is not a contrived case —
    // it is the same three rows through the idiom every module reached for.
    const naive: unknown = rows.reduce<unknown>((s, r) => (s as number) + (r.amount as never), 0);
    expect(naive).toBe('010.504.500');
  });

  it('refuses a poisoned row rather than returning a plausible total', () => {
    expect(() => sumNumeric([{ a: '1' }, { a: 'NaN' }], (r) => r.a)).toThrow(
      NumericConversionError,
    );
  });
});

describe('roundMoney', () => {
  it('brings a float back to the minor unit', () => {
    expect(0.1 + 0.2).not.toBe(0.3); // the reason this function exists
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(roundMoney(49 + 10)).toBe(59);
    expect(roundMoney(2.005)).toBe(2.01);
    expect(roundMoney(1.23456, 4)).toBe(1.2346);
  });
});

describe('isStorableNumeric', () => {
  it('answers what PostgreSQL will not: whether this belongs in a NUMERIC column', () => {
    // PostgreSQL accepts NaN into NUMERIC and then compares it as larger than
    // every number, so `CHECK (col >= 0)` passes on it. The guard has to be here.
    expect(isStorableNumeric('12.5')).toBe(true);
    expect(isStorableNumeric(null)).toBe(true);
    expect(isStorableNumeric(Number.NaN)).toBe(false);
    expect(isStorableNumeric('NaN')).toBe(false);
  });
});

/**
 * The engine and the SDK each carry a copy — the engine's production code has
 * never taken a runtime dependency on the SDK, and a pure converter is not the
 * thing to change that for. Deliberate twins drift; this is what stops them.
 */
describe('engine and SDK copies agree', () => {
  const cases: unknown[] = ['0', '1234.56', '-7.5', 42, 123n, null, undefined, 'NaN', '', {}];

  it('gives the same answer, or throws in the same places', () => {
    for (const value of cases) {
      let mine: unknown;
      let theirs: unknown;
      try {
        mine = toNumber(value);
      } catch {
        mine = 'THREW';
      }
      try {
        theirs = sdk.toNumber(value);
      } catch {
        theirs = 'THREW';
      }
      expect({ value: String(value), result: mine }).toEqual({
        value: String(value),
        result: theirs,
      });
    }
  });

  it('rounds money identically', () => {
    for (const v of [0.1 + 0.2, 2.005, 59, 1.23456]) {
      expect(roundMoney(v)).toBe(sdk.roundMoney(v));
    }
  });
});
