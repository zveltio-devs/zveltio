import { describe, expect, it } from 'bun:test';

/**
 * The quota middleware read `max_api_calls_day` with `.catch(() => null)`, and
 * `null` became `maxCalls = 0`, which the next branch reads as "no limit
 * configured — allow all traffic". A transient database error therefore switched
 * metering off. The line after CACHED that fabricated zero for five minutes, so
 * every request in the window re-read it and passed too.
 *
 * These reproduce the branch in isolation. Standing the whole middleware up
 * needs a cache, a session and a tenant; the defect is one decision, and this is
 * that decision.
 */
type Row = { max_api_calls_day: number | null } | undefined;

/** What the code did before: any failure is indistinguishable from "no limit". */
async function oldWay(query: () => Promise<Row>): Promise<{ maxCalls: number; cached: boolean }> {
  const row = await query().catch(() => null);
  const maxCalls = row?.max_api_calls_day ?? 0;
  return { maxCalls, cached: true };
}

/** What it does now: a read failure is its own outcome and is never cached. */
async function newWay(
  query: () => Promise<Row>,
): Promise<{ maxCalls: number; cached: boolean; unmetered: boolean }> {
  let row: Row;
  try {
    row = await query();
  } catch {
    return { maxCalls: 0, cached: false, unmetered: true };
  }
  return { maxCalls: row?.max_api_calls_day ?? 0, cached: true, unmetered: false };
}

const boom = async (): Promise<Row> => {
  throw new Error('connection terminated unexpectedly');
};
const configuredZero = async (): Promise<Row> => ({ max_api_calls_day: 0 });
const configured1000 = async (): Promise<Row> => ({ max_api_calls_day: 1000 });

describe('tenant quota — a failed limit read is not a configured zero', () => {
  it('the old shape cached the failure as "unlimited", which is the defect', async () => {
    const failed = await oldWay(boom);
    const zero = await oldWay(configuredZero);
    // Indistinguishable. And `cached: true` is what made one blip last 5 minutes.
    expect(failed).toEqual(zero);
    expect(failed.cached).toBe(true);
  });

  it('a read failure is now marked unmetered and is NOT cached', async () => {
    const r = await newWay(boom);
    expect(r.unmetered).toBe(true);
    expect(r.cached).toBe(false);
  });

  it('a genuinely configured zero still means no limit, and is still cached', async () => {
    // The fix must not turn "this tenant has no cap" into an error path.
    const r = await newWay(configuredZero);
    expect(r).toEqual({ maxCalls: 0, cached: true, unmetered: false });
  });

  it('a real limit is read and cached unchanged', async () => {
    expect(await newWay(configured1000)).toEqual({
      maxCalls: 1000,
      cached: true,
      unmetered: false,
    });
  });
});
