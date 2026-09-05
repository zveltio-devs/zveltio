import { describe, expect, it } from 'bun:test';
import { runQualityScan } from '../../lib/data-quality.js';
import { runWithDomain } from '../../lib/tenancy/index.js';

/**
 * A quality scan runs in the firm that asked for it, or it does not run.
 *
 * `tenantId` used to default to `DEFAULT_TENANT_ID`, and the only production
 * caller — the `analytics/quality` extension — passes four arguments. So every
 * scan on the instance opened `withTenantIsolation(root)` whatever firm asked
 * for it: it read the ROOT tenant's rows, and the issues handed back carried
 * root's record ids and field values in their descriptions. Neither
 * `zv_quality_scans` nor `zv_quality_issues` has a `tenant_id` to have caught it
 * afterwards.
 *
 * The point of these cases is the shape of the fallback, not the scan: absence
 * of a tenant is a bug, not the root tenant.
 */
describe('runQualityScan picks a tenant', () => {
  // A handle that fails on first use — the scan must be refused before it ever
  // reaches the database, so nothing here needs one.
  const db = {
    insertInto() {
      throw new Error('the scan reached the database, which it should not have');
    },
  } as never;

  it('refuses outside a request rather than scanning the root tenant', async () => {
    await expect(runQualityScan(db, 'contacts', 'full', 'user-1')).rejects.toThrow(
      /needs a tenant/,
    );
  });

  it('says what it refused and why, so the caller is not left guessing', async () => {
    // A message naming the root tenant is the whole point: the next person to
    // meet this has to understand it was a refusal, not a failure.
    await expect(runQualityScan(db, 'contacts', 'full', 'user-1')).rejects.toThrow(/root tenant/);
  });

  it('takes the tenant from the request when the caller names none', async () => {
    // Inside a domain the call gets past the guard and reaches the database —
    // which this stub refuses, and that refusal is the evidence.
    await expect(
      runWithDomain('11111111-2222-3333-4444-555555555555', () =>
        runQualityScan(db, 'contacts', 'full', 'user-1'),
      ),
    ).rejects.toThrow(/reached the database/);
  });
});
