/**
 * Replicas booting together each re-grant every public table to zveltio_rls.
 * Run unserialised, the two grant loops update the same catalog rows and one
 * fails with "tuple concurrently updated", logged as a failed grant.
 */
import { describe, expect, it, spyOn } from 'bun:test';
import { initRlsEnforcementRole } from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('zveltio_rls grants at concurrent boots', () => {
  it('four replicas granting at once log no failed grant', async () => {
    const { db } = await getTestApp();
    const warn = spyOn(console, 'warn');
    try {
      for (let round = 0; round < 3; round++) {
        await Promise.all([1, 2, 3, 4].map(() => initRlsEnforcementRole(db)));
      }
      const failed = warn.mock.calls
        .map((args) => args.map(String).join(' '))
        .filter((line) => line.includes('[tenant-rls]'));
      expect(failed).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  }, 120_000);
});
