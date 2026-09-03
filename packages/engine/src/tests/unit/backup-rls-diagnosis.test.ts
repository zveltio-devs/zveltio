/**
 * A backup that fails because of RLS must not send the operator to the one
 * command that removes the tenant boundary.
 *
 * On the hardened install the engine's role is `NOSUPERUSER NOBYPASSRLS` and
 * owns the tables; `FORCE ROW LEVEL SECURITY` binds the owner, and pg_dump
 * refuses. Measured on a virgin database with zero collections — it fails on
 * `zv_edge_function_logs`, which ships with FORCE RLS from migration 049.
 *
 * Postgres's own HINT on that error tells you to run
 * `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY`. Correct for Postgres, wrong
 * here: it fixes the backup by switching off the isolation the backup exists to
 * protect. These tests pin the answer to that hint.
 */

import { describe, expect, it } from 'bun:test';
import { explainDumpFailure } from '../../routes/backup.js';

// The exact stderr from `pg_dump` against a NOSUPERUSER owner, captured
// 2026-09-02 on a freshly migrated database.
const REAL_STDERR = [
  'pg_dump: error: query failed: ERROR:  query would be affected by row-level security policy for table "zv_edge_function_logs"',
  "HINT:  To disable the policy for the table's owner, use ALTER TABLE NO FORCE ROW LEVEL SECURITY.",
  'pg_dump: detail: Query was: COPY public.zv_edge_function_logs (id, function_id, status) TO stdout;',
].join('\n');

describe('an RLS-blocked pg_dump explains itself', () => {
  const explained = explainDumpFailure(REAL_STDERR);

  it('keeps the original error — the operator still needs the table name', () => {
    expect(explained).toContain('zv_edge_function_logs');
    expect(explained).toContain('row-level security policy');
  });

  it('contradicts the HINT instead of leaving it as the last word', () => {
    // Postgres's hint is still in the text (it is part of the error), so the
    // test that matters is that our refusal comes AFTER it.
    const hint = explained.indexOf('NO FORCE ROW LEVEL SECURITY');
    const refusal = explained.indexOf('DO NOT follow the HINT');
    expect(hint).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(hint);
    expect(explained).toContain('removes the tenant boundary');
  });

  it('warns off --enable-row-security, the fix that would silently lose tenants', () => {
    expect(explained).toContain('--enable-row-security');
    expect(explained).toContain('silently omit every other tenant');
  });

  it('names the actual remedy', () => {
    expect(explained).toContain('BYPASSRLS');
    expect(explained).toContain('docs/platform/disaster-recovery.md');
  });

  it('leaves an unrelated failure completely untouched', () => {
    // A disk-full or bad-password failure must not collect a lecture about RLS.
    const other =
      'pg_dump: error: connection to server failed: FATAL:  password authentication failed';
    expect(explainDumpFailure(other)).toBe(other);
  });

  it('matches either spelling Postgres uses', () => {
    expect(explainDumpFailure('ERROR: row level security is enabled')).toContain('BYPASSRLS');
    expect(explainDumpFailure('ERROR: row-level security is enabled')).toContain('BYPASSRLS');
  });
});
