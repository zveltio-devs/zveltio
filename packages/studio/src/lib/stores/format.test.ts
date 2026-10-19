import { beforeEach, describe, expect, it, vi } from 'vitest';

/** "Today" is the tenant's date (#1187), not the UTC one `toISOString()` gives. */
const getPublic = vi.hoisted(() => vi.fn());
vi.mock('../api.js', () => ({ settingsApi: { getPublic } }));

// 22:30 UTC on the 18th is already the 19th in Bucharest.
const lateEvening = new Date('2026-10-18T22:30:00Z');

async function todayWith(timezone: unknown): Promise<string> {
  vi.resetModules();
  getPublic.mockResolvedValue({ timezone });
  const { initFormat, localToday } = await import('./format.svelte.js');
  await initFormat();
  return localToday(lateEvening);
}

beforeEach(() => getPublic.mockReset());

describe('localToday', () => {
  it("is the tenant's date, not the UTC one", async () => {
    expect(await todayWith('Europe/Bucharest')).toBe('2026-10-19');
    expect(await todayWith('America/New_York')).toBe('2026-10-18');
  });

  it("falls back to the browser's date for a zone it does not know", async () => {
    const browser = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(lateEvening);
    expect(await todayWith('Mars/Olympus_Mons')).toBe(browser);
  });
});
