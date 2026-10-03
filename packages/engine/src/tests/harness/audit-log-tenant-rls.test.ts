/**
 * `zv_audit_log` is isolated by Postgres (migrations 040/041).
 *
 * The table had no `tenant_id`, so every reader saw every firm's trail and no
 * extension could be handed "this tenant's recent activity" — the dashboard read
 * the whole instance's log. Rows now carry the writing transaction's tenant, a
 * NULL tenant is an instance-level event (boot, god actions, logins, tenant
 * administration), and a policy decides who sees what.
 *
 * The harness pool is a superuser, where no policy binds, so reads that must be
 * judged by the policy run as `zveltio_rls` — inside a tenant transaction, or
 * through a pool whose every connection is that role (what a correctly
 * provisioned install connects as).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { Kysely, sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { BunSqlDialect } from '../../db/bun-sql-dialect.js';
import { parseMigrationFile, splitSqlStatements } from '../../db/migrations/index.js';
import type { DbSchema } from '../../db/schema.js';
import { _settleAuditWrites, auditLog, type AuditEventType } from '../../lib/audit.js';
import { gateInternals } from '../../lib/extensions/capabilities.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import type { ExtensionInternals } from '../../lib/extensions/internals.js';
import { runGarbageCollector } from '../../lib/runtime/garbage-collector.js';
import {
  reconcileExtensionTenantRLS,
  runWithDomain,
  withTenantIsolation,
} from '../../lib/tenancy/index.js';
import { registerSystemRoutes } from '../../routes/admin/system-routes.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const A = crypto.randomUUID();
const B = crypto.randomUUID();
const TAG = `auditrls-${A.slice(0, 8)}`;
const EV = `${TAG}.event` as AuditEventType;

/** The harness URL, every connection opened as the plain role. */
function plainRoleUrl(): string {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.searchParams.set('options', '-c role=zveltio_rls');
  return url.toString();
}

const migration = async (file: string) =>
  parseMigrationFile(
    await Bun.file(new URL(`../../db/migrations/sql/${file}`, import.meta.url)).text(),
  );

d('zv_audit_log under tenant RLS', () => {
  let app: Hono;
  let db: Database;
  let plain: Database;
  let cookie: string;
  let godId: string;
  let internals: ExtensionInternals;

  /** What this transaction may read of the rows this file wrote, as `resource_id`s. */
  const visible = async (trx: Database) =>
    (
      await sql<{ resource_id: string }>`
        SELECT resource_id FROM zv_audit_log WHERE event_type = ${EV} ORDER BY resource_id`.execute(
        trx,
      )
    ).rows.map((r) => r.resource_id);

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    plain = new Kysely<DbSchema>({
      dialect: new BunSqlDialect({ connectionString: plainRoleUrl(), max: 2 }),
    }) as unknown as Database;
    cookie = await createGodSession(app, db);
    godId = (await sql<{ id: string }>`SELECT id FROM "user" WHERE role = 'god'`.execute(db))
      .rows[0]!.id;
    for (const id of [A, B]) {
      await sql`INSERT INTO zv_tenants (id, slug, name, status)
                VALUES (${id}::uuid, ${`${TAG}-${id.slice(0, 4)}`}, ${TAG}, 'active')`.execute(db);
    }
    // Through the real writer, naming no tenant: the transaction decides.
    await withTenantIsolation(A, (trx) => auditLog(trx, { type: EV, resourceId: 'a' }));
    await withTenantIsolation(B, (trx) => auditLog(trx, { type: EV, resourceId: 'b' }));
    await auditLog(db, { type: EV, resourceId: 'instance' });
    internals = gateInternals('audit-ext', buildExtensionInternals(), ['audit:read']);
  });

  afterAll(async () => {
    await plain?.destroy().catch(() => undefined);
    if (!db) return;
    await _settleAuditWrites();
    await sql`DELETE FROM zv_audit_log WHERE event_type LIKE ${`${TAG}%`}`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id IN (${A}::uuid, ${B}::uuid)`.execute(db);
  });

  it('a write in a tenant transaction is stamped with that tenant; one outside is instance-level', async () => {
    const r = await sql<{ resource_id: string; tenant_id: string | null }>`
      SELECT resource_id, tenant_id::text AS tenant_id FROM zv_audit_log
       WHERE event_type = ${EV} ORDER BY resource_id`.execute(db);
    expect(r.rows).toEqual([
      { resource_id: 'a', tenant_id: A },
      { resource_id: 'b', tenant_id: B },
      { resource_id: 'instance', tenant_id: null },
    ]);
  });

  it('the boot reconciler hands no instance row to the default tenant', async () => {
    await reconcileExtensionTenantRLS(db);
    const r = await sql<{ tenant_id: string | null }>`
      SELECT tenant_id::text AS tenant_id FROM zv_audit_log
       WHERE event_type = ${EV} AND resource_id = 'instance'`.execute(db);
    expect(r.rows).toEqual([{ tenant_id: null }]);
  });

  it("a tenant reads its own rows only — not another tenant's, not the instance's", async () => {
    expect(await withTenantIsolation(A, visible)).toEqual(['a']);
    expect(await withTenantIsolation(B, visible)).toEqual(['b']);
  });

  it('god in a tenant request sees every firm, and still not the instance rows', async () => {
    expect(await withTenantIsolation(A, visible, { userId: godId })).toEqual(['a', 'b']);
  });

  it('a tenant cannot write a row for another tenant or an instance-level row', async () => {
    const forge = (tenant: string | null) =>
      withTenantIsolation(A, (trx) =>
        sql`INSERT INTO zv_audit_log (event_type, resource_id, tenant_id)
            VALUES (${EV}, 'forged', ${tenant}::uuid)`.execute(trx),
      );
    await expect(forge(B)).rejects.toThrow(/row-level security/);
    await expect(forge(null)).rejects.toThrow(/row-level security/);
  });

  it('the instance audit route shows every firm and the instance rows, on a plain-role pool', async () => {
    // As an install that connects as a plain role: no superuser to fall back on.
    const route = new Hono();
    registerSystemRoutes(route, plain);
    const res = await route.request(`/audit?event_type=${EV}&limit=10`);
    expect(res.status).toBe(200);
    const { audit } = (await res.json()) as { audit: { resource_id: string }[] };
    expect(audit.map((r) => r.resource_id).sort()).toEqual(['a', 'b', 'instance']);
  });

  it('the instance admin reads the instance rows through /api/admin/audit', async () => {
    const res = await app.request(`/api/admin/audit?event_type=${EV}&limit=10`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const { audit } = (await res.json()) as { audit: { resource_id: string }[] };
    expect(audit.map((r) => r.resource_id).sort()).toEqual(['a', 'b', 'instance']);
  });

  it('readAuditActivity returns the running tenant’s rows only, even where RLS shows more', async () => {
    const only = (rows: { resource_id: string | null }[]) =>
      rows.filter((r) => r.resource_id !== null).map((r) => r.resource_id);
    // No transaction open: the helper opens the tenant's own.
    const inA = await runWithDomain(A, () => internals.readAuditActivity({ eventType: EV }));
    expect(only(inA)).toEqual(['a']);
    expect(Object.keys(inA[0]!).sort()).toEqual(
      ['created_at', 'event_type', 'id', 'resource_id', 'resource_type', 'user_id'].sort(),
    );
    // Inside god's request transaction the policy admits both firms; the
    // helper's own tenant filter is what keeps B out.
    const asGod = await withTenantIsolation(
      A,
      () => internals.readAuditActivity({ eventType: EV }),
      { userId: godId },
    );
    expect(only(asGod)).toEqual(['a']);
    await expect(internals.readAuditActivity()).rejects.toThrow(/no tenant runs here/);
  });

  it("an extension's audit row is the running tenant's, and reads back through readAuditActivity", async () => {
    const EXT = `${TAG}.ext`;
    await runWithDomain(B, () => internals.audit({ type: EXT, resourceId: 'from-ext' }));
    await _settleAuditWrites();
    const inB = await runWithDomain(B, () => internals.readAuditActivity({ eventType: EXT }));
    expect(inB.map((r) => r.resource_id)).toEqual(['from-ext']);
    const inA = await runWithDomain(A, () => internals.readAuditActivity({ eventType: EXT }));
    expect(inA).toEqual([]);
  });

  it('readAuditActivity caps the limit', async () => {
    await withTenantIsolation(A, async (trx) => {
      for (let i = 0; i < 105; i++) await auditLog(trx, { type: `${TAG}.bulk` as AuditEventType });
    });
    const rows = await runWithDomain(A, () =>
      internals.readAuditActivity({ eventType: `${TAG}.bulk`, limit: 10_000 }),
    );
    expect(rows.length).toBe(100);
  });

  it('retention purges every firm’s and the instance’s old rows on a plain-role pool', async () => {
    const OLD = `${TAG}.old` as AuditEventType;
    await withTenantIsolation(B, (trx) => auditLog(trx, { type: OLD, resourceId: 'b' }));
    await auditLog(db, { type: OLD, resourceId: 'instance' });
    await sql`UPDATE zv_audit_log SET created_at = now() - interval '400 days'
               WHERE event_type = ${OLD}`.execute(db);
    await runGarbageCollector(plain);
    const left = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zv_audit_log WHERE event_type = ${OLD}`.execute(db);
    expect(left.rows[0]!.n).toBe(0);
  });

  it('040 runs twice, rolls back and runs again; 041 runs twice', async () => {
    const m40 = await migration('040_audit_log_tenant.sql');
    const m41 = await migration('041_audit_log_tenant_index.sql');
    const rollback = new Error('rollback');
    await db
      .transaction()
      .execute(async (trx) => {
        for (const part of [m40.up, m40.up, m40.down ?? '', m40.up]) {
          for (const stmt of splitSqlStatements(part)) await sql.raw(stmt).execute(trx);
        }
        throw rollback;
      })
      .catch((err) => {
        if (err !== rollback) throw err;
      });
    for (const part of [m41.up, m41.up]) {
      for (const stmt of splitSqlStatements(part)) await sql.raw(stmt).execute(db);
    }
    expect(await withTenantIsolation(A, visible)).toEqual(['a']);
  });
});
