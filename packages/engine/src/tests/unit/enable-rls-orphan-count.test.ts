/**
 * `enableRLS` — "I could not check" is not "there is nothing to fix".
 *
 * After row-level security goes on, rows with a NULL `tenant_id` become
 * invisible to every tenant: the policy `tenant_id::text = current_setting(...)`
 * evaluates to NULL, not true. The function counts them and warns loudly so an
 * operator backfills before treating the table as multi-tenant-safe — and the
 * comment above it says exactly that.
 *
 * The count carried `.catch(() => ({ rows: [{ orphan_count: 0 }] }))`, so a
 * failed count reported zero orphans and the `if (orphanCount > 0)` warning was
 * skipped. The loud surfacing the comment promised went silent in precisely the
 * case where the operator has least reason to suspect anything.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { enableRLS, initTenantManager } from '../../lib/tenancy/index.js';
import { CannedDb } from './fixtures/canned-db.js';

let warnings: string[];
let realWarn: typeof console.warn;

beforeEach(() => {
  warnings = [];
  realWarn = console.warn;
  console.warn = (...a: unknown[]) => void warnings.push(a.map(String).join(' '));
});
afterEach(() => {
  console.warn = realWarn;
});

describe('enableRLS — counting rows that RLS just made invisible', () => {
  it('says the count could not be taken, rather than reporting no orphans', async () => {
    const db = new CannedDb();
    db.fail(/orphan_count/i, new Error('statement timeout'));
    initTenantManager(db.kysely as unknown as Database);

    await enableRLS('zvd_invoices');

    expect(warnings.some((w) => /UNKNOWN whether any are now invisible/.test(w))).toBe(true);
    // And it hands over the query to run by hand, rather than only saying it failed.
    expect(
      warnings.some((w) => /SELECT COUNT\(\*\) FROM zvd_invoices WHERE tenant_id IS NULL/.test(w)),
    ).toBe(true);
  });

  it('still names the number when there ARE orphans', async () => {
    const db = new CannedDb();
    db.when(/orphan_count/i, [{ orphan_count: 7 }]);
    initTenantManager(db.kysely as unknown as Database);

    await enableRLS('zvd_invoices');

    expect(warnings.some((w) => /7 row\(s\)/.test(w))).toBe(true);
    expect(warnings.some((w) => /Backfill with: UPDATE zvd_invoices/.test(w))).toBe(true);
  });

  it('says nothing when there are none, which is the ordinary case', async () => {
    const db = new CannedDb();
    db.when(/orphan_count/i, [{ orphan_count: 0 }]);
    initTenantManager(db.kysely as unknown as Database);

    await enableRLS('zvd_invoices');

    expect(warnings.filter((w) => /tenant-manager/.test(w))).toHaveLength(0);
  });
});
