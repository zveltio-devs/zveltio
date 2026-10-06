import { describe, expect, it } from 'bun:test';

// By path: the script lives outside this package's rootDir.
type Entry = { session: { date: string; verdict: string; section: string }; file?: string };
const { orderSessions } = (await import(
  new URL('../../../../../scripts/lib/review-sessions.ts', import.meta.url).pathname
)) as { orderSessions: (e: Entry[]) => Array<Entry['session']> };

/**
 * The review checklist takes a section's latest verdict from the last session
 * in this order. It was glob order, so one section read "closed" on one
 * checkout and "logged" on another, and the generated file churned by hundreds
 * of lines with nothing new recorded.
 */
const s = (section: string, date: string, verdict: string) => ({ section, date, verdict });

describe('review sessions order', () => {
  const files = [
    { session: s('A04', '2026-09-30', 'closed'), file: 'A04-2026-09-30-3.json' },
    { session: s('A04', '2026-09-04', 'logged'), file: 'A04-2026-09-04-1.json' },
    { session: s('A04', '2026-09-04', 'fixed'), file: 'A04-2026-09-04-2.json' },
    { session: s('A04', '2026-09-04', 'tenth'), file: 'A04-2026-09-04-10.json' },
  ];

  it('is by date, then the sequence in the file name, whatever order they were read in', () => {
    const want = ['logged', 'fixed', 'tenth', 'closed'];
    for (const order of [
      [0, 1, 2, 3],
      [3, 2, 1, 0],
      [2, 0, 3, 1],
      [1, 3, 0, 2],
    ]) {
      expect(orderSessions(order.map((i) => files[i]!)).map((x) => x.verdict)).toEqual(want);
    }
  });

  it('keeps legacy entries (no file) in their own order, before same-day files', () => {
    const out = orderSessions([
      { session: s('A01', '2026-09-04', 'file'), file: 'A01-2026-09-04-1.json' },
      { session: s('A01', '2026-09-04', 'legacy-1') },
      { session: s('A01', '2026-09-04', 'legacy-2') },
    ]);
    expect(out.map((x) => x.verdict)).toEqual(['legacy-1', 'legacy-2', 'file']);
  });
});
