/**
 * Gate — a unique key on a natural column must include `tenant_id`.
 *
 * Sixty-one constraints across twenty-seven extensions were written before
 * multi-tenancy and never widened when `tenant_id` and RLS arrived. The effect
 * was that the second company on a shared instance could not use a value the
 * first had taken: its own invoice number, its own product SKU, its own chart of
 * accounts, its own fiscal year. Verified on a live instance before the fix —
 * company A inserts FACT-2026-0001, company B inserts the same number and gets
 *
 *   duplicate key value violates unique constraint "zvd_invoices_number_key"
 *
 * with RLS hiding the offending row, so the error names something the second
 * company cannot see and has no way to resolve.
 *
 * Nothing detected this. Every test ran as one company, which is the one case
 * where the schema is correct. This gate reads the live catalogue instead, so it
 * fails on a table nobody thought to write a test for.
 *
 * What is deliberately allowed through:
 *
 *   - a single-column key on `id` — UUIDs are globally unique already;
 *   - keys on tokens, hashes and secrets — those MUST collide across the whole
 *     instance, that is the point of them;
 *   - keys made of `*_id` columns — a UUID parent already belongs to one
 *     company, so the child cannot straddle two;
 *   - tables with no `tenant_id` at all, which are instance-wide by design
 *     (`zv_settings` is the usual one).
 *
 * KNOWN, deliberate: `zv_extension_registry (name)`. Widening it is a step
 * toward per-tenant extension enablement, which `requireInstanceAdmin` blocks
 * anyway, and its `tenant_id` has no DEFAULT — so a widened key plus the
 * swallowed `.catch(() => {})` on the enable path would silently insert a new
 * row per enable instead of updating. It gets its own pass, with the default and
 * all five conflict targets, or not at all.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

/** Widening these is tracked separately — see the note above. */
const ALLOWED = new Set(['zv_extension_registry_name_key']);

d('unique keys are scoped to the tenant (in-process)', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
  });

  it('no natural-key constraint omits tenant_id', async () => {
    const res = await sql<{
      tabel: string;
      conname: string;
      cols: string;
    }>`
      WITH suspect AS (
        SELECT c.relname AS tabel,
               con.conname AS conname,
               (SELECT string_agg(a.attname, ',' ORDER BY a.attnum)
                  FROM unnest(con.conkey) k
                  JOIN pg_attribute a
                    ON a.attrelid = con.conrelid AND a.attnum = k) AS cols
          FROM pg_constraint con
          JOIN pg_class c     ON c.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND con.contype IN ('p', 'u')
           AND EXISTS (SELECT 1 FROM information_schema.columns col
                        WHERE col.table_name = c.relname
                          AND col.column_name = 'tenant_id')
           AND NOT EXISTS (SELECT 1 FROM unnest(con.conkey) k
                             JOIN pg_attribute a
                               ON a.attrelid = con.conrelid AND a.attnum = k
                            WHERE a.attname = 'tenant_id')
      )
      SELECT tabel, conname, cols
        FROM suspect
       WHERE cols <> 'id'
         AND cols !~ '(token|hash|secret)'
         AND cols !~ '_id($|,)'
       ORDER BY tabel
    `.execute(db);

    const offenders = res.rows.filter((r) => !ALLOWED.has(r.conname));

    expect(
      offenders.map((r) => `${r.tabel} (${r.cols})`),
      'a unique key on a natural column must include tenant_id, or the second ' +
        'company on this instance cannot use a value the first one took',
    ).toEqual([]);
  });

  it('two companies may hold the same invoice number, one company may not', async () => {
    const A = '00000000-0000-0000-0000-000000000001';
    const B = '00000000-0000-0000-0000-0000000000ff';
    const number = `GATE-${Date.now()}`;

    // `zvd_invoices` belongs to finance/invoicing, so it is absent on an
    // engine-only database — which is what this lane runs. The catalogue check
    // above is the part that must hold everywhere; this one demonstrates the
    // behaviour wherever the extension is actually installed.
    const present = await sql<{ ok: boolean }>`
      SELECT to_regclass('zvd_invoices') IS NOT NULL AS ok
    `.execute(db);
    if (!present.rows[0]?.ok) return;

    const rows = await sql<{ id: string }>`SELECT id FROM "user" LIMIT 1`.execute(db);
    const author = rows.rows[0]?.id;
    if (!author) return; // nothing to attribute the row to on an empty install

    const issue = (tenant: string, client: string) => sql`
      INSERT INTO zvd_invoices
        (tenant_id, number, client_name, status, issue_date, due_date, total, created_by)
      VALUES
        (${tenant}::uuid, ${number}, ${client}, 'draft',
         CURRENT_DATE, CURRENT_DATE, 100, ${author})
    `;

    await sql`SAVEPOINT gate_unique_keys`.execute(db).catch(() => {});
    try {
      await issue(A, 'Client A').execute(db);
      // The whole point: the same number, a different company.
      await issue(B, 'Client B').execute(db);

      // And the key still has to do its job inside one company.
      await expect(issue(B, 'Client B again').execute(db)).rejects.toThrow(/duplicate key/i);
    } finally {
      await sql`ROLLBACK TO SAVEPOINT gate_unique_keys`.execute(db).catch(() => {});
      await sql`DELETE FROM zvd_invoices WHERE number = ${number}`.execute(db).catch(() => {});
    }
  });

  afterAll(async () => {
    // Nothing to tear down: both cases clean up after themselves above.
  });
});
