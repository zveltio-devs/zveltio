/**
 * `zv_audit_log` is append-only for the engine's request role (ADR 0060
 * decision 1, migration 128).
 *
 * `zveltio_rls` held SELECT, INSERT, UPDATE, DELETE, and the boot reconciler
 * re-granted them every start, so any path that reached the request role could
 * rewrite or remove the trail. Only the retention purge deletes now, as
 * `zveltio_audit_purge`, and only rows older than the window it states.
 * A user's deletion (GDPR erasure) no longer rewrites their rows: `user_id`
 * keeps the id, which stops naming anyone once the profile is gone (decision 2).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { parseMigrationFile, splitSqlStatements } from '../../db/migrations/index.js';
import { _settleAuditWrites, type AuditEventType, auditLog } from '../../lib/audit.js';
import { runGarbageCollector } from '../../lib/runtime/garbage-collector.js';
import {
  DEFAULT_TENANT_ID,
  ensureRlsEnforcementRole,
  withTenantIsolation,
} from '../../lib/tenancy/index.js';
import {
  asEveryTenant,
  asTenant,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TAG = `appendonly-${crypto.randomUUID().slice(0, 8)}`;
const EV = `${TAG}.event` as AuditEventType;
/** A tenant that was purged: its rows outlive it until retention takes them. */
const GONE = crypto.randomUUID();

d('zv_audit_log is append-only (ADR 0060)', () => {
  let db: Database;

  const rows = (where: ReturnType<typeof sql>) =>
    asEveryTenant(db, async (trx) => {
      // The purged tenant is in no `zv_tenants` row, so no published reach shows it.
      await sql`SELECT set_config('zveltio.visible_tenants',
                  current_setting('zveltio.visible_tenants') || ',' || ${GONE}, true)`.execute(trx);
      return (
        await sql<{ resource_id: string }>`
        SELECT resource_id FROM zv_audit_log WHERE event_type LIKE ${`${TAG}%`} AND ${where}
         ORDER BY resource_id`.execute(trx)
      ).rows.map((r) => r.resource_id);
    });

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await withTenantIsolation(DEFAULT_TENANT_ID, (trx) =>
      auditLog(trx, { type: EV, resourceId: 'fresh' }),
    );
  });

  afterAll(async () => {
    if (!db) return;
    await _settleAuditWrites();
    // As the table owner, which keeps DELETE (the hash chain of s3 is what holds it).
    for (const t of [DEFAULT_TENANT_ID, GONE]) {
      await asTenant(db, t, (trx) =>
        sql`DELETE FROM zv_audit_log WHERE event_type LIKE ${`${TAG}%`}`.execute(trx),
      );
    }
    await sql`DELETE FROM zv_audit_log WHERE event_type LIKE ${`${TAG}%`}`.execute(db);
  });

  it('the request role appends and reads, and may neither rewrite nor delete a row', async () => {
    const as = (q: ReturnType<typeof sql>) =>
      withTenantIsolation(DEFAULT_TENANT_ID, (trx) => q.execute(trx));
    await expect(
      as(sql`UPDATE zv_audit_log SET resource_id = 'rewritten' WHERE event_type = ${EV}`),
    ).rejects.toThrow(/permission denied/);
    await expect(as(sql`DELETE FROM zv_audit_log WHERE event_type = ${EV}`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(as(sql`TRUNCATE zv_audit_log`)).rejects.toThrow(/permission denied/);
    expect(await rows(sql`true`)).toEqual(['fresh']);
  });

  it('no engine role but the purge role may delete, after the boot reconciler re-granted', async () => {
    await ensureRlsEnforcementRole(db);
    const r = await sql<{ role: string; update: boolean; delete: boolean; truncate: boolean }>`
      SELECT rolname AS role,
             has_table_privilege(oid, 'public.zv_audit_log', 'UPDATE') AS update,
             has_table_privilege(oid, 'public.zv_audit_log', 'DELETE') AS delete,
             has_table_privilege(oid, 'public.zv_audit_log', 'TRUNCATE') AS truncate
        FROM pg_roles
       WHERE rolname ~ '^zveltio_' AND NOT rolcanlogin
         AND (has_table_privilege(oid, 'public.zv_audit_log', 'UPDATE')
              OR has_table_privilege(oid, 'public.zv_audit_log', 'DELETE')
              OR has_table_privilege(oid, 'public.zv_audit_log', 'TRUNCATE'))
       ORDER BY rolname`.execute(db);
    expect(r.rows).toEqual([
      { role: 'zveltio_audit_purge', update: false, delete: true, truncate: false },
    ]);
  });

  it('the purge role deletes nothing younger than its window, nor anything without one', async () => {
    const asPurge = (days: string | null, q: ReturnType<typeof sql>) =>
      db.transaction().execute(async (trx) => {
        await sql`SELECT set_config('role', 'zveltio_audit_purge', true)`.execute(trx);
        if (days !== null) {
          await sql`SELECT set_config('zveltio.audit_retention_days', ${days}, true)`.execute(trx);
        }
        return q.execute(trx);
      });
    const del = sql`DELETE FROM zv_audit_log WHERE event_type = ${EV}`;
    for (const days of [null, '', '0', '365']) {
      expect(Number((await asPurge(days, del)).numAffectedRows)).toBe(0);
    }
    await expect(
      asPurge('1', sql`UPDATE zv_audit_log SET resource_id = 'x' WHERE event_type = ${EV}`),
    ).rejects.toThrow(/permission denied/);
    expect(await rows(sql`true`)).toEqual(['fresh']);
  });

  it("retention purges every firm's expired rows, a purged firm's included, and keeps the rest", async () => {
    const OLD = `${TAG}.old` as AuditEventType;
    await asTenant(db, GONE, (trx) => auditLog(trx, { type: OLD, resourceId: 'gone-old' }));
    await asTenant(db, GONE, (trx) => auditLog(trx, { type: EV, resourceId: 'gone-fresh' }));
    await auditLog(db, { type: OLD, resourceId: 'instance-old', tenantId: null });
    // Aged by the owner, as each row's writer could.
    for (const t of [GONE, null]) {
      const age = (h: Database) =>
        sql`UPDATE zv_audit_log SET created_at = now() - interval '400 days'
             WHERE event_type = ${OLD}`.execute(h);
      await (t ? asTenant(db, t, age) : age(db));
    }
    expect(await rows(sql`true`)).toEqual(['fresh', 'gone-fresh', 'gone-old', 'instance-old']);
    await runGarbageCollector(db);
    expect(await rows(sql`true`)).toEqual(['fresh', 'gone-fresh']);
  });

  it('128 runs twice, rolls back and runs again', async () => {
    const m = parseMigrationFile(
      await Bun.file(
        new URL('../../db/migrations/sql/128_audit_log_append_only.sql', import.meta.url),
      ).text(),
    );
    const updatable = (trx: Database) =>
      sql<{ ok: boolean }>`
        SELECT has_table_privilege('zveltio_rls', 'public.zv_audit_log', 'UPDATE') AS ok`
        .execute(trx)
        .then((r) => r.rows[0]?.ok);
    const rollback = new Error('rollback');
    const seen: boolean[] = [];
    await db
      .transaction()
      .execute(async (trx) => {
        for (const part of [m.up, m.up, m.down ?? '', m.up]) {
          for (const stmt of splitSqlStatements(part)) await sql.raw(stmt).execute(trx);
          seen.push(!!(await updatable(trx)));
        }
        throw rollback;
      })
      .catch((err) => {
        if (err !== rollback) throw err;
      });
    expect(seen).toEqual([false, false, true, false]);
  });
});
