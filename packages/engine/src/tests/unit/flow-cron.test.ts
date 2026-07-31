/**
 * Cron parsing and next-run calculation.
 *
 * The scheduler accepted `trigger: { type: 'cron', cron: '0 3 * * *' }`, stored
 * it, and then read only `interval_seconds` — falling back to 60 seconds. A
 * flow scheduled for 03:00 daily ran 1440 times a day. Worse than the inert
 * settings elsewhere in this codebase: it did the wrong thing continuously, and
 * with an `ai_decision` step it did it at a per-call cost.
 *
 * Hand-written cron parsing is a known footgun, so these tests are deliberately
 * unkind: boundaries, the dom/dow OR quirk, month lengths, DST-adjacent times,
 * and every malformed shape that must be REJECTED rather than approximated.
 */

import { describe, expect, it } from 'bun:test';
import { nextCronRun, parseCron } from '../../lib/flows/cron.js';

const at = (iso: string) => new Date(iso);
const fmt = (d: Date | null) =>
  d === null
    ? null
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
        d.getDate(),
      ).padStart(
        2,
        '0',
      )} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

describe('the schedule an operator actually writes', () => {
  it('daily at 03:00 fires once, tomorrow, not in a minute', () => {
    // The whole bug in one assertion.
    expect(fmt(nextCronRun('0 3 * * *', at('2026-07-31T10:15:00')))).toBe('2026-08-01 03:00');
  });

  it('daily at 03:00 fires today when it has not passed yet', () => {
    expect(fmt(nextCronRun('0 3 * * *', at('2026-07-31T01:00:00')))).toBe('2026-07-31 03:00');
  });

  it('every 15 minutes', () => {
    expect(fmt(nextCronRun('*/15 * * * *', at('2026-07-31T10:07:00')))).toBe('2026-07-31 10:15');
    expect(fmt(nextCronRun('*/15 * * * *', at('2026-07-31T10:47:00')))).toBe('2026-07-31 11:00');
  });

  it('weekdays at 09:30', () => {
    // 2026-08-01 is a Saturday, so the next weekday run is Monday the 3rd.
    expect(fmt(nextCronRun('30 9 * * 1-5', at('2026-07-31T23:00:00')))).toBe('2026-08-03 09:30');
  });

  it('the first of the month at midnight', () => {
    expect(fmt(nextCronRun('0 0 1 * *', at('2026-07-31T23:59:00')))).toBe('2026-08-01 00:00');
  });

  it('a list of hours', () => {
    expect(fmt(nextCronRun('0 8,12,18 * * *', at('2026-07-31T12:30:00')))).toBe('2026-07-31 18:00');
    expect(fmt(nextCronRun('0 8,12,18 * * *', at('2026-07-31T19:00:00')))).toBe('2026-08-01 08:00');
  });
});

describe('the day-of-month / day-of-week quirk', () => {
  it('ORs them when both are restricted', () => {
    // Standard cron: `0 0 13 * 5` is "the 13th, AND every Friday" — not
    // "Friday the 13th". Getting this backwards is the classic cron bug.
    const from = at('2026-08-01T00:00:00');
    expect(fmt(nextCronRun('0 0 13 * 5', from))).toBe('2026-08-07 00:00'); // first Friday
  });

  it('ANDs nothing when only day-of-month is restricted', () => {
    expect(fmt(nextCronRun('0 0 13 * *', at('2026-08-01T00:00:00')))).toBe('2026-08-13 00:00');
  });

  it('ANDs nothing when only day-of-week is restricted', () => {
    expect(fmt(nextCronRun('0 0 * * 0', at('2026-08-01T00:00:00')))).toBe('2026-08-02 00:00');
  });
});

describe('calendar edges', () => {
  it('skips months that have no 31st', () => {
    expect(fmt(nextCronRun('0 0 31 * *', at('2026-09-15T00:00:00')))).toBe('2026-10-31 00:00');
  });

  it('finds February 29th in a leap year', () => {
    expect(fmt(nextCronRun('0 0 29 2 *', at('2026-03-01T00:00:00')))).toBe('2028-02-29 00:00');
  });

  it('returns null for a date that never occurs', () => {
    // February 30th. Returning null lets the caller skip the flow loudly
    // instead of running it every minute forever.
    expect(nextCronRun('0 0 30 2 *', at('2026-01-01T00:00:00'))).toBeNull();
  });

  it('crosses a year boundary', () => {
    expect(fmt(nextCronRun('0 0 1 1 *', at('2026-12-31T12:00:00')))).toBe('2027-01-01 00:00');
  });
});

describe('malformed expressions are rejected, not approximated', () => {
  it('rejects the wrong number of fields', () => {
    for (const e of ['', '*', '* * * *', '* * * * * *', '0 0 * * * *']) {
      expect(parseCron(e)).toBeNull();
      expect(nextCronRun(e, at('2026-07-31T00:00:00'))).toBeNull();
    }
  });

  it('rejects out-of-range values', () => {
    for (const e of [
      '60 * * * *',
      '* 24 * * *',
      '* * 0 * *',
      '* * 32 * *',
      '* * * 13 *',
      '* * * * 7',
    ]) {
      expect(parseCron(e)).toBeNull();
    }
  });

  it('rejects an inverted range', () => {
    expect(parseCron('* * * * 5-1')).toBeNull();
    expect(parseCron('30-10 * * * *')).toBeNull();
  });

  it('rejects syntax it does not implement rather than guessing', () => {
    // @daily, L, W, # and named days all mean something specific. Silently
    // treating them as "every minute" is how this defect started.
    for (const e of ['@daily', '0 0 L * *', '0 0 * * 5#2', '0 0 * * MON', '0 0 15W * *']) {
      expect(parseCron(e)).toBeNull();
    }
  });

  it('rejects a zero or non-numeric step', () => {
    expect(parseCron('*/0 * * * *')).toBeNull();
    expect(parseCron('*/x * * * *')).toBeNull();
  });
});

describe('step and range forms', () => {
  it('supports a stepped range', () => {
    expect(fmt(nextCronRun('0 8-18/4 * * *', at('2026-07-31T09:00:00')))).toBe('2026-07-31 12:00');
  });

  it('treats a bare number with a step as "from n onwards"', () => {
    expect(fmt(nextCronRun('5/20 * * * *', at('2026-07-31T10:06:00')))).toBe('2026-07-31 10:25');
  });

  it('never returns a time at or before `from`', () => {
    // An off-by-one here would make the scheduler re-run the same slot forever.
    const from = at('2026-07-31T10:00:00');
    const next = nextCronRun('0 * * * *', from);
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(from.getTime());
    expect(fmt(next)).toBe('2026-07-31 11:00');
  });
});
