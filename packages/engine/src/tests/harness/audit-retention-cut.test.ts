/**
 * The audit trail's retention window per tenant, and the purge cutting each
 * chain from its oldest end and recording the new genesis (ADR 0060 decision 4,
 * migration 130).
 *
 * Before 130 the purge left its rows' chain entries, verify counted rows gone at
 * the oldest end as purged — and so passed rows the owner deleted there with
 * the append-only trigger off. The database let the purge role delete any
 * tenant's rows older than the one window the purge stated.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { parseMigrationFile, splitSqlStatements } from '../../db/migrations/index.js';
import {
  _settleAuditWrites,
  type AuditEventType,
  auditLog,
  verifyAuditChains,
} from '../../lib/audit.js';
import { runGarbageCollector } from '../../lib/runtime/garbage-collector.js';
import { ensureRlsEnforcementRole, withTenantIsolation } from '../../lib/tenancy/index.js';
import {
  asAuditOwner,
  asEveryTenant,
  asTenant,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TAG = `auditcut-${crypto.randomUUID().slice(0, 8)}`;
const EV = `${TAG}.event` as AuditEventType;
/** One fresh tenant per case, so each chain starts at its own genesis. */
const T = {
  short: crypto.randomUUID(),
  long: crypto.randomUUID(),
  owner: crypto.randomUUID(),
  order: crypto.randomUUID(),
  whole: crypto.randomUUID(),
  bad: crypto.randomUUID(),
};
const ENV = 'AUDIT_LOG_RETENTION_TENANT_DAYS';

d('audit retention per tenant, chain cut from the oldest end (ADR 0060 decision 4)', () => {
  let db: Database;

  /** A row of `tenant` written `ageDays` ago, linked into its chain at commit. */
  const write = (tenant: string, resourceId: string, ageDays = 0) =>
    asTenant(db, tenant, (trx) =>
      sql`INSERT INTO zv_audit_log (event_type, resource_id, tenant_id, created_at)
          VALUES (${EV}, ${resourceId}, ${tenant}::uuid,
                  now() - make_interval(days => ${ageDays}::int))`.execute(trx),
    );
  const chainOf = async (tenant: string) =>
    (await verifyAuditChains(db)).chains.find((c) => c.tenant_id === tenant);
  const rowsOf = async (tenant: string) =>
    (
      await asEveryTenant(db, (trx) =>
        sql<{ resource_id: string }>`SELECT resource_id FROM zv_audit_log
           WHERE event_type = ${EV} AND tenant_id = ${tenant}::uuid
           ORDER BY created_at`.execute(trx),
      )
    ).rows.map((r) => r.resource_id);
  const asPurge = (tenant: string, days: number, q: ReturnType<typeof sql>) =>
    db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('role', 'zveltio_audit_purge', true),
                       set_config('zveltio.audit_retention_days', ${String(days)}, true),
                       set_config('zveltio.audit_purge_tenant', ${tenant}, true)`.execute(trx);
      return q.execute(trx);
    });

  beforeAll(async () => {
    ({ db } = await getTestApp());
    for (const id of Object.values(T)) {
      await sql`INSERT INTO zv_tenants (id, slug, name, status)
                VALUES (${id}::uuid, ${`${TAG}-${id.slice(0, 8)}`}, ${TAG}, 'active')`.execute(db);
    }
  });

  afterEach(() => {
    delete process.env[ENV];
  });

  afterAll(async () => {
    if (!db) return;
    await _settleAuditWrites();
    const ids = Object.values(T);
    await asAuditOwner(db, async (trx) => {
      await sql`DELETE FROM zv_audit_log WHERE event_type LIKE ${`${TAG}%`}`.execute(trx);
      for (const t of ['zv_audit_chain', 'zv_audit_chain_cut']) {
        const trigger = `${t}_append_only`;
        await sql.raw(`ALTER TABLE ${t} DISABLE TRIGGER ${trigger}`).execute(trx);
        await sql`DELETE FROM ${sql.table(t)} WHERE tenant_id = ANY(${ids}::uuid[])`.execute(trx);
        await sql.raw(`ALTER TABLE ${t} ENABLE TRIGGER ${trigger}`).execute(trx);
      }
    });
    await sql`DELETE FROM zv_tenants WHERE id = ANY(${ids}::uuid[])`.execute(db);
  });

  it("each tenant keeps its own window; the cut moves the chain's genesis and the chain goes on", async () => {
    for (const [r, age] of [
      ['s1', 40],
      ['s2', 30],
      ['s3', 0],
    ] as const) {
      await write(T.short, r, age);
    }
    for (const [r, age] of [
      ['l1', 40],
      ['l2', 0],
    ] as const) {
      await write(T.long, r, age);
    }
    const s2 = (await chainOf(T.short))?.head;
    expect(s2?.seq).toBe(3);

    process.env[ENV] = `${T.short}=20, ${T.long.toUpperCase()}=0`;
    await runGarbageCollector(db);

    expect(await rowsOf(T.short)).toEqual(['s3']);
    expect(await rowsOf(T.long)).toEqual(['l1', 'l2']);
    const cut = await chainOf(T.short);
    expect(cut).toMatchObject({ ok: true, verified: 1, genesis: { seq: 2 }, head: { seq: 3 } });
    const entries = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zv_audit_chain WHERE tenant_id = ${T.short}::uuid`.execute(
      db,
    );
    expect(entries.rows[0]!.n).toBe(1);

    await withTenantIsolation(T.short, (trx) => auditLog(trx, { type: EV, resourceId: 's4' }));
    await _settleAuditWrites();
    expect(await chainOf(T.short)).toMatchObject({ ok: true, verified: 2, head: { seq: 4 } });
  });

  it('rows the owner deleted at the oldest end, the trigger off, break the chain', async () => {
    for (const r of ['o1', 'o2', 'o3']) await write(T.owner, r);
    await asAuditOwner(
      db,
      sql`DELETE FROM zv_audit_log WHERE event_type = ${EV} AND resource_id IN ('o1', 'o2')`,
    );
    const chain = await chainOf(T.owner);
    expect(chain).toMatchObject({ ok: false, verified: 0, genesis: null });
    expect(chain?.broken).toMatchObject({ seq: 1, reason: 'row_missing' });
  });

  it("the purge role deletes only the stated chain's rows older than its window, from the oldest end", async () => {
    await write(T.order, 'r1', 0);
    await write(T.order, 'r2', 40);
    const del = (resourceId: string) =>
      sql`DELETE FROM zv_audit_log WHERE event_type = ${EV} AND resource_id = ${resourceId}`;

    // Another chain's window, or this one's too long: the row is not in reach.
    expect(Number((await asPurge(T.long, 10, del('r2'))).numAffectedRows)).toBe(0);
    expect(Number((await asPurge('instance', 10, del('r2'))).numAffectedRows)).toBe(0);
    expect(Number((await asPurge(T.order, 50, del('r2'))).numAffectedRows)).toBe(0);
    // In reach, but a younger row is older in the chain: not the oldest end.
    await expect(asPurge(T.order, 10, del('r2'))).rejects.toThrow(/oldest end only/);
    expect(await rowsOf(T.order)).toEqual(['r2', 'r1']);
    expect(await chainOf(T.order)).toMatchObject({ ok: true, verified: 2, genesis: null });

    // The engine's purge stops at the first row inside the window.
    process.env[ENV] = `${T.order}=10`;
    await runGarbageCollector(db);
    expect(await rowsOf(T.order)).toEqual(['r2', 'r1']);
  });

  it('a chain cut to its last entry continues from its genesis', async () => {
    for (const r of ['w1', 'w2']) await write(T.whole, r, 40);
    process.env[ENV] = `${T.whole}=20`;
    await runGarbageCollector(db);
    expect(await rowsOf(T.whole)).toEqual([]);
    expect(await chainOf(T.whole)).toMatchObject({
      ok: true,
      verified: 0,
      genesis: { seq: 2 },
      head: { seq: 2 },
    });
    await write(T.whole, 'w3');
    expect(await chainOf(T.whole)).toMatchObject({ ok: true, verified: 1, head: { seq: 3 } });
  });

  it('a malformed override purges no audit row', async () => {
    await write(T.bad, 'b1', 400);
    for (const value of [`${T.bad}=20,oops`, `${T.bad}=1y`, `${T.bad}=20,${T.bad}=30`]) {
      process.env[ENV] = value;
      await runGarbageCollector(db);
      expect(await rowsOf(T.bad)).toEqual(['b1']);
    }
  });

  it('the request role holds nothing on the cuts; the purge role only reads the chain', async () => {
    await ensureRlsEnforcementRole(db);
    const r = await sql<{ rls: boolean; purge_read: boolean; purge_write: boolean }>`
      SELECT has_table_privilege('zveltio_rls', 'public.zv_audit_chain_cut',
               'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') AS rls,
             has_table_privilege('zveltio_audit_purge', 'public.zv_audit_chain', 'SELECT') AS purge_read,
             has_table_privilege('zveltio_audit_purge', 'public.zv_audit_chain',
               'INSERT, UPDATE, DELETE, TRUNCATE') AS purge_write`.execute(db);
    expect(r.rows[0]).toEqual({ rls: false, purge_read: true, purge_write: false });
    for (const q of [
      sql`UPDATE zv_audit_chain_cut SET seq = seq`,
      sql`DELETE FROM zv_audit_chain_cut`,
      sql`TRUNCATE zv_audit_chain_cut`,
    ]) {
      await expect(asEveryTenant(db, q)).rejects.toThrow(/append-only/);
    }
  });

  it('130 runs twice, rolls back and runs again', async () => {
    const m = parseMigrationFile(
      await Bun.file(
        new URL('../../db/migrations/sql/130_audit_retention_cut.sql', import.meta.url),
      ).text(),
    );
    const cutTrigger = (trx: Database) =>
      sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_trigger
                          WHERE tgname = 'zv_audit_log_cut'`
        .execute(trx)
        .then((r) => r.rows[0]!.n);
    const rollback = new Error('rollback');
    const seen: number[] = [];
    await db
      .transaction()
      .execute(async (trx) => {
        for (const part of [m.up, m.up, m.down ?? '', m.up]) {
          for (const stmt of splitSqlStatements(part)) await sql.raw(stmt).execute(trx);
          seen.push(await cutTrigger(trx));
        }
        throw rollback;
      })
      .catch((err) => {
        if (err !== rollback) throw err;
      });
    expect(seen).toEqual([1, 1, 0, 1]);
  });
});
