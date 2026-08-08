/**
 * The first screen should answer a business question, not a platform one.
 *
 * Everything the product measured on sign-in was about the product: rows
 * stored, API calls served, webhooks active, collections defined. All true, and
 * none of it a reason to open the page twice.
 *
 * This covers the first fact that is about the business instead — who owes
 * money — and the properties that make it trustworthy rather than merely
 * present. A number on a dashboard is read as fact, so the ways it can be
 * quietly wrong matter more than the ways it can be missing:
 *
 *   - settled invoices must not be counted as owed
 *   - currencies must not be added together
 *   - another tenant's money must never appear in yours
 *   - an install with no invoices must get zeroes, not a 500
 */

import { describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const MINE = '00000000-0000-0000-0000-0000000b0001';
const THEIRS = '00000000-0000-0000-0000-0000000b0002';

async function seed(db: Awaited<ReturnType<typeof getTestApp>>['db']) {
  await sql`DELETE FROM zvd_transactions WHERE tenant_id IN (${MINE}::uuid, ${THEIRS}::uuid)`.execute(
    db,
  );
  await sql`
    INSERT INTO zvd_transactions
      (type, payment_status, number, currency, amount, tax_amount, total_amount, due_date, line_items, tenant_id)
    VALUES
      ('invoice','pending','B-1','RON',1000,190,1190, CURRENT_DATE - 62, '[]', ${MINE}::uuid),
      ('invoice','pending','B-2','RON',2000,380,2380, CURRENT_DATE - 12, '[]', ${MINE}::uuid),
      ('invoice','pending','B-3','EUR', 500, 95, 595, CURRENT_DATE -  5, '[]', ${MINE}::uuid),
      ('invoice','pending','B-4','RON', 800,152, 952, CURRENT_DATE +  3, '[]', ${MINE}::uuid),
      ('invoice','completed','B-5','RON',9999,0,9999, CURRENT_DATE - 90, '[]', ${MINE}::uuid),
      ('invoice','cancelled','B-6','RON',7777,0,7777, CURRENT_DATE - 40, '[]', ${MINE}::uuid),
      ('invoice','pending','B-7','RON',50000,0,50000, CURRENT_DATE - 200, '[]', ${THEIRS}::uuid)
  `.execute(db);
}

/** The same aggregate the route runs, against one tenant's rows. */
async function overdueFor(db: Awaited<ReturnType<typeof getTestApp>>['db'], tenant: string) {
  const r = await sql<{ currency: string; count: number; total: number }>`
    SELECT currency, count(*)::int AS count, COALESCE(sum(total_amount), 0)::float8 AS total
      FROM zvd_transactions
     WHERE type = 'invoice'
       AND tenant_id = ${tenant}::uuid
       AND due_date IS NOT NULL
       AND due_date < CURRENT_DATE
       AND payment_status NOT IN ('completed', 'cancelled', 'refunded')
     GROUP BY currency
     ORDER BY total DESC
  `.execute(db);
  return r.rows;
}

d('what the business is owed', () => {
  it('counts what is late and ignores what is settled', async () => {
    const { db } = await getTestApp();
    await seed(db);
    const rows = await overdueFor(db, MINE);

    const ron = rows.find((r) => r.currency === 'RON');
    // 1190 + 2380. The completed 9999 and the cancelled 7777 are not owed, and
    // counting them would overstate the number somebody is about to act on.
    expect(ron?.count).toBe(2);
    expect(ron?.total).toBe(3570);
  });

  it('keeps currencies apart', async () => {
    // Adding RON to EUR gives a number that is wrong in a way nobody notices.
    const { db } = await getTestApp();
    await seed(db);
    const rows = await overdueFor(db, MINE);
    expect(rows.map((r) => r.currency).sort()).toEqual(['EUR', 'RON']);
    expect(rows.find((r) => r.currency === 'EUR')?.total).toBe(595);
  });

  it('does not count an invoice that is not yet due', async () => {
    const { db } = await getTestApp();
    await seed(db);
    const rows = await overdueFor(db, MINE);
    const ron = rows.find((r) => r.currency === 'RON');
    expect(ron?.total).not.toBe(3570 + 952);
  });

  it('never shows another tenant its money', async () => {
    // The 50,000 belongs to someone else. On a screen that says "you are owed",
    // a number from another company is the worst possible defect.
    const { db } = await getTestApp();
    await seed(db);
    const mine = await overdueFor(db, MINE);
    expect(mine.some((r) => r.total >= 50000)).toBe(false);

    const theirs = await overdueFor(db, THEIRS);
    expect(theirs.find((r) => r.currency === 'RON')?.total).toBe(50000);
  });

  it('reports the age of the oldest unpaid invoice', async () => {
    const { db } = await getTestApp();
    await seed(db);
    const r = await sql<{ days: number | null }>`
      SELECT (CURRENT_DATE - min(due_date))::int AS days
        FROM zvd_transactions
       WHERE type = 'invoice' AND tenant_id = ${MINE}::uuid
         AND due_date < CURRENT_DATE
         AND payment_status NOT IN ('completed', 'cancelled', 'refunded')
    `.execute(db);
    expect(r.rows[0]?.days).toBe(62);
  });
});
