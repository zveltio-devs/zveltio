/**
 * The audit trail's hash chain per tenant and its verify endpoint (ADR 0060
 * decision 3, migration 129), and the table owner bound like every other role.
 *
 * Each row is linked at COMMIT under the tenant's advisory lock:
 * `hash = SHA-256(prev_hash || SHA-256(canonical row))`. Verify reports the first
 * broken link of each chain. Tampering is done here the only way left to the
 * owner — switching the append-only trigger off, which is DDL — and the chain
 * shows it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { parseMigrationFile, splitSqlStatements } from '../../db/migrations/index.js';
import {
  _settleAuditWrites,
  type AuditEventType,
  auditLog,
  verifyAuditChains,
} from '../../lib/audit.js';
import { ensureRlsEnforcementRole, withTenantIsolation } from '../../lib/tenancy/index.js';
import {
  asAuditOwner,
  asEveryTenant,
  asTenant,
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TAG = `auditchain-${crypto.randomUUID().slice(0, 8)}`;
const EV = `${TAG}.event` as AuditEventType;
/** One fresh tenant per case, so each chain starts at its own genesis. */
const T = {
  burst: crypto.randomUUID(),
  held: crypto.randomUUID(),
  canon: crypto.randomUUID(),
  changed: crypto.randomUUID(),
  missing: crypto.randomUUID(),
  purged: crypto.randomUUID(),
  link: crypto.randomUUID(),
};

d('zv_audit_log hash chain (ADR 0060 decision 3)', () => {
  let app: Hono;
  let db: Database;

  const write = (tenant: string, resourceId: string) =>
    withTenantIsolation(tenant, (trx) => auditLog(trx, { type: EV, resourceId }));
  const chainOf = async (tenant: string) =>
    (await verifyAuditChains(db)).chains.find((c) => c.tenant_id === tenant);
  const idOf = async (resourceId: string) =>
    (
      await asEveryTenant(db, (trx) =>
        sql<{ id: string }>`SELECT id::text AS id FROM zv_audit_log
           WHERE event_type = ${EV} AND resource_id = ${resourceId}`.execute(trx),
      )
    ).rows[0]!.id;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    for (const id of Object.values(T)) {
      await sql`INSERT INTO zv_tenants (id, slug, name, status)
                VALUES (${id}::uuid, ${`${TAG}-${id.slice(0, 8)}`}, ${TAG}, 'active')`.execute(db);
    }
  });

  afterAll(async () => {
    if (!db) return;
    await _settleAuditWrites();
    const ids = Object.values(T);
    await asAuditOwner(db, async (trx) => {
      await sql`DELETE FROM zv_audit_log WHERE event_type LIKE ${`${TAG}%`}`.execute(trx);
      await sql`ALTER TABLE zv_audit_chain DISABLE TRIGGER zv_audit_chain_append_only`.execute(trx);
      await sql`DELETE FROM zv_audit_chain WHERE tenant_id = ANY(${ids}::uuid[])`.execute(trx);
      await sql`ALTER TABLE zv_audit_chain ENABLE TRIGGER zv_audit_chain_append_only`.execute(trx);
    });
    await sql`DELETE FROM zv_tenants WHERE id = ANY(${ids}::uuid[])`.execute(db);
  });

  it('concurrent appends to one tenant form one unbroken chain', async () => {
    await Promise.all(Array.from({ length: 24 }, (_, i) => write(T.burst, `burst-${i}`)));
    const chain = await chainOf(T.burst);
    expect(chain).toMatchObject({ ok: true, verified: 24, genesis: null });
    expect(chain?.head?.seq).toBe(24);
  });

  it('a transaction holding an appended row does not block another connection appending to the same tenant', async () => {
    // A BEFORE INSERT lock would be held here until COMMIT, and the inner write —
    // a second connection of the same process — would wait on the outer one,
    // which waits on it: a hang Postgres cannot see. The chain links at COMMIT.
    const order: string[] = [];
    await asTenant(db, T.held, async (outer) => {
      await auditLog(outer, { type: EV, resourceId: 'outer' });
      const inner = asTenant(db, T.held, (trx) =>
        auditLog(trx, { type: EV, resourceId: 'inner' }),
      ).then(() => 'committed');
      const timeout = new Promise((r) => setTimeout(() => r('blocked'), 5000));
      order.push((await Promise.race([inner, timeout])) as string);
    });
    expect(order).toEqual(['committed']);
    expect(await chainOf(T.held)).toMatchObject({ ok: true, verified: 2 });
    // Commit order, not insert order.
    const seqs = await asEveryTenant(
      db,
      sql<{ resource_id: string; seq: number }>`
      SELECT a.resource_id, c.seq::int AS seq FROM zv_audit_chain c
        JOIN zv_audit_log a ON a.id = c.audit_id
       WHERE c.tenant_id = ${T.held}::uuid ORDER BY c.seq`,
    );
    expect(seqs.rows.map((r) => r.resource_id)).toEqual(['inner', 'outer']);
  });

  it('the canonical form is fixed, and the same in every session', async () => {
    const fields = {
      id: '0b9b6a52-6f0e-4a8e-9a43-2c1f7f0d6a11',
      event_type: 'x.y',
      user_id: null,
      resource_id: 'r',
      resource_type: 't',
      metadata: { b: 1, a: [1.5, 'ș"\\'] },
      ip: '10.0.0.1',
      created_at: '2026-01-02T03:04:05.123456Z',
      tenant_id: '6c3e1f1e-0a52-4e0b-8a43-6f1a3b2c4d5e',
    };
    const expected = createHash('sha256')
      .update(
        `[1, "${fields.id}", "x.y", null, "r", "t", {"a": [1.5, "ș\\"\\\\"], "b": 1}, ` +
          `"10.0.0.1", "2026-01-02T03:04:05.123456Z", "${fields.tenant_id}"]`,
      )
      .digest('hex');
    const hashIn = (settings: string, json: string) =>
      db.transaction().execute(async (trx) => {
        if (settings) await sql.raw(settings).execute(trx);
        return (
          await sql<{ h: string }>`
            SELECT encode(zveltio_audit_content_hash(
              jsonb_populate_record(NULL::zv_audit_log, ${json}::text::jsonb)), 'hex') AS h`.execute(
            trx,
          )
        ).rows[0]!.h;
      });
    const json = JSON.stringify(fields);
    // Keys in another order: jsonb normalizes them.
    const reordered = JSON.stringify({
      ...fields,
      metadata: { a: [1.5, 'ș"\\'], b: 1 },
      created_at: '2026-01-02 05:04:05.123456+02',
    });
    const seen = new Set([
      await hashIn('', json),
      await hashIn("SET LOCAL TimeZone = 'Pacific/Chatham'", json),
      await hashIn("SET LOCAL DateStyle = 'SQL, DMY'; SET LOCAL TimeZone = 'America/Lima'", json),
      await hashIn('SET LOCAL extra_float_digits = -15', reordered),
    ]);
    expect([...seen]).toEqual([expected]);

    // And the trigger stores the same function's value for a real row.
    await write(T.canon, 'canon');
    const r = await asEveryTenant(db, (trx) =>
      sql<{ stored: string; now: string }>`
        SELECT encode(c.content_hash, 'hex') AS stored,
               encode(zveltio_audit_content_hash(a), 'hex') AS now
          FROM zv_audit_log a JOIN zv_audit_chain c ON c.audit_id = a.id
         WHERE a.event_type = ${EV} AND a.resource_id = 'canon'`.execute(trx),
    );
    expect(r.rows[0]!.stored).toBe(r.rows[0]!.now);
  });

  it('the table owner may not rewrite, delete or truncate the trail or its chain', async () => {
    await write(T.changed, 'c1');
    for (const q of [
      sql`UPDATE zv_audit_log SET resource_id = 'x' WHERE event_type = ${EV}`,
      sql`DELETE FROM zv_audit_log WHERE event_type = ${EV}`,
      sql`TRUNCATE zv_audit_log`,
      sql`UPDATE zv_audit_chain SET seq = seq WHERE tenant_id = ${T.changed}::uuid`,
      sql`DELETE FROM zv_audit_chain WHERE tenant_id = ${T.changed}::uuid`,
      sql`TRUNCATE zv_audit_chain`,
    ]) {
      await expect(asEveryTenant(db, q)).rejects.toThrow(/append-only/);
    }
  });

  it('the request role holds no privilege on the chain, after the boot reconciler re-granted', async () => {
    await ensureRlsEnforcementRole(db);
    const r = await sql<{ any: boolean }>`
      SELECT has_table_privilege('zveltio_rls', 'public.zv_audit_chain',
               'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') AS any`.execute(db);
    expect(r.rows[0]!.any).toBe(false);
  });

  it('verify names the first row rewritten behind the trigger, over HTTP to an instance admin only', async () => {
    for (const r of ['c2', 'c3']) await write(T.changed, r);
    expect(await chainOf(T.changed)).toMatchObject({ ok: true, verified: 3 });
    const c2 = await idOf('c2');
    await asAuditOwner(
      db,
      sql`UPDATE zv_audit_log SET resource_id = 'c2-forged' WHERE id = ${c2}::uuid`,
    );

    expect(await chainOf(T.changed)).toMatchObject({
      ok: false,
      verified: 1,
      head: { seq: 1 },
      broken: { seq: 2, audit_id: c2, reason: 'row_changed' },
    });

    const god = await createGodSession(app, db);
    const res = await app.request('/api/admin/audit/verify', { headers: { cookie: god } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Awaited<ReturnType<typeof verifyAuditChains>>;
    expect(body.ok).toBe(false);
    expect(body.chains.find((c) => c.tenant_id === T.changed)?.broken).toEqual({
      seq: 2,
      audit_id: c2,
      reason: 'row_changed',
    });

    const member = await createMemberSession(app, db);
    const refused = await app.request('/api/admin/audit/verify', {
      headers: { cookie: member.cookie },
    });
    expect(refused.status).toBe(403);
  });

  it('a row deleted inside the chain breaks it, and at the oldest end too (no genesis covers it)', async () => {
    for (const r of ['m1', 'm2', 'm3']) await write(T.missing, r);
    for (const r of ['p1', 'p2', 'p3']) await write(T.purged, r);
    const m2 = await idOf('m2');
    const p1 = await idOf('p1');
    await asAuditOwner(db, async (trx) => {
      await sql`DELETE FROM zv_audit_log WHERE id = ${m2}::uuid`.execute(trx);
      // The oldest rows, deleted outside the retention purge: nothing is cut
      // (audit-retention-cut.test.ts has the purge's own cut).
      await sql`DELETE FROM zv_audit_log WHERE event_type = ${EV}
                  AND resource_id IN ('p1', 'p2')`.execute(trx);
    });
    expect(await chainOf(T.missing)).toMatchObject({
      ok: false,
      broken: { seq: 2, audit_id: m2, reason: 'row_missing' },
    });
    expect(await chainOf(T.purged)).toMatchObject({
      ok: false,
      verified: 0,
      broken: { seq: 1, audit_id: p1, reason: 'row_missing' },
    });
  });

  it('a rewritten chain entry breaks the link after it; a row written with the chain off is unchained', async () => {
    for (const r of ['l1', 'l2', 'l3']) await write(T.link, r);
    await asAuditOwner(db, async (trx) => {
      await sql`ALTER TABLE zv_audit_chain DISABLE TRIGGER zv_audit_chain_append_only`.execute(trx);
      await sql`UPDATE zv_audit_chain SET content_hash = sha256('forged'::bytea)
                 WHERE tenant_id = ${T.link}::uuid AND seq = 2`.execute(trx);
      await sql`ALTER TABLE zv_audit_chain ENABLE TRIGGER zv_audit_chain_append_only`.execute(trx);
    });
    expect((await chainOf(T.link))?.broken).toMatchObject({ seq: 2, reason: 'link' });

    await asAuditOwner(db, async (trx) => {
      await sql`ALTER TABLE zv_audit_log DISABLE TRIGGER zv_audit_log_chain`.execute(trx);
      await sql`SELECT set_config('zveltio.current_tenant', ${T.link}, true)`.execute(trx);
      await sql`INSERT INTO zv_audit_log (event_type, resource_id, tenant_id)
                VALUES (${EV}, 'loose', ${T.link}::uuid)`.execute(trx);
      await sql`ALTER TABLE zv_audit_log ENABLE TRIGGER zv_audit_log_chain`.execute(trx);
    });
    const report = await verifyAuditChains(db);
    expect(report.unchained).toEqual({ audit_id: await idOf('loose'), tenant_id: T.link });
    expect(report.ok).toBe(false);
  });

  it('129 runs twice, rolls back, and chains the rows written before it', async () => {
    const m = parseMigrationFile(
      await Bun.file(
        new URL('../../db/migrations/sql/129_audit_log_hash_chain.sql', import.meta.url),
      ).text(),
    );
    // 130 builds on 129: its way down comes first.
    const m130 = parseMigrationFile(
      await Bun.file(
        new URL('../../db/migrations/sql/130_audit_retention_cut.sql', import.meta.url),
      ).text(),
    );
    const run = async (trx: Database, part: string) => {
      for (const stmt of splitSqlStatements(part)) await sql.raw(stmt).execute(trx);
    };
    const rollback = new Error('rollback');
    let unchained = -1;
    let forced = false;
    await db
      .transaction()
      .execute(async (trx) => {
        await run(trx, m130.down ?? '');
        await run(trx, m.up);
        await run(trx, m.up);
        await run(trx, m.down ?? '');
        // Written while there is no chain: one tenant's row and an instance row.
        await sql`SELECT set_config('zveltio.current_tenant', ${T.canon}, true)`.execute(trx);
        await sql`INSERT INTO zv_audit_log (event_type, resource_id) VALUES (${EV}, 'before')`.execute(
          trx,
        );
        await sql`SELECT set_config('zveltio.current_tenant', '', true)`.execute(trx);
        await sql`INSERT INTO zv_audit_log (event_type, resource_id) VALUES (${EV}, 'before')`.execute(
          trx,
        );
        await run(trx, m.up);
        forced = (
          await sql<{ f: boolean }>`
            SELECT relforcerowsecurity AS f FROM pg_class WHERE oid = 'zv_audit_log'::regclass`.execute(
            trx,
          )
        ).rows[0]!.f;
        // To count every firm's rows, a purged one's included.
        await sql.raw('ALTER TABLE zv_audit_log NO FORCE ROW LEVEL SECURITY').execute(trx);
        unchained = (
          await sql<{ n: number }>`
            SELECT count(*)::int AS n FROM zv_audit_log a
             WHERE NOT EXISTS (SELECT 1 FROM zv_audit_chain c WHERE c.audit_id = a.id)`.execute(trx)
        ).rows[0]!.n;
        throw rollback;
      })
      .catch((err) => {
        if (err !== rollback) throw err;
      });
    expect(unchained).toBe(0);
    expect(forced).toBe(true);
  });
});
