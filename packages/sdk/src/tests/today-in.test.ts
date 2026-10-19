import { describe, expect, it } from 'bun:test';
import { todayIn } from '../extension/dates.js';

describe('todayIn', () => {
  // 22:30 UTC on the 18th is already the 19th in Bucharest (UTC+3 in October).
  const lateUtc = new Date('2026-10-18T22:30:00Z');

  it('is the tenant’s date, not the UTC one, across midnight', () => {
    expect(todayIn('Europe/Bucharest', lateUtc)).toBe('2026-10-19');
    expect(todayIn('UTC', lateUtc)).toBe('2026-10-18');
    expect(todayIn('America/New_York', new Date('2026-10-19T02:00:00Z'))).toBe('2026-10-18');
  });

  it('formats as ISO YYYY-MM-DD', () => {
    expect(todayIn('UTC', new Date('2026-01-05T12:00:00Z'))).toBe('2026-01-05');
  });
});
