/**
 * An extension's tenant policy that could not be put on the host's predicate
 * stops the extension from loading.
 *
 * Extension templates put the READ predicate in WITH CHECK, which lets a
 * consolidating parent write into a child's rows; `runExtensionMigrations`
 * rewrites the policies its run touched. That rewrite was best-effort: a table
 * it could not rewrite only warned and the extension loaded anyway, and a
 * `-- NO TRANSACTION` migration that threw midway skipped the rewrite outright,
 * leaving the policies its earlier statements had committed as they were.
 *
 * Driven through `runExtensionMigrations`, the function every load path (boot,
 * install, enable, reload) runs an extension's migrations through.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { runExtensionMigrations } from '../../lib/extensions/migration-runner.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const STAMP = Date.now();
const BAD = `rclbad${STAMP}`;
const BAD_TABLE = `zv_${BAD}_rows`;
const MID = `rclmid${STAMP}`;
const MID_TABLE = `zv_${MID}_rows`;
const RST = `rclrst${STAMP}`;
const RST_TABLE = `zv_${RST}_rows`;
const DIR = `${process.env.TMPDIR ?? '/tmp'}/zv-ext-rcl-${STAMP}`;

const ext = (name: string, file: string) =>
  ({ name, getMigrations: () => [`${DIR}/${file}`] }) as unknown as ZveltioExtension;

d('extension migrations: a tenant policy left permissive fails the load', () => {
  let db: Database;
  let health: () => Promise<{
    ok: boolean;
    detail?: { failed: { table: string; error: string }[] };
  }>;

  // By name: once rewritten, the table also carries the `tenant_own_node_*`
  // policies, which have no WITH CHECK, and pg_policies has no order.
  const withCheck = async (table: string) =>
    (
      await sql<{ c: string }>`
        SELECT coalesce(with_check, '') AS c FROM pg_policies
         WHERE schemaname = 'public' AND tablename = ${table}
           AND policyname = ${`tenant_isolation_${table}`}`.execute(db)
    ).rows[0]?.c;

  async function cleanup(): Promise<void> {
    for (const t of [BAD_TABLE, MID_TABLE, RST_TABLE])
      await sql`DROP TABLE IF EXISTS ${sql.id(t)}`.execute(db);
    for (const e of [BAD, MID, RST]) {
      await sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${e}:%`}`.execute(db);
    }
  }

  beforeAll(async () => {
    let app: Awaited<ReturnType<typeof getTestApp>>['app'];
    ({ app, db } = await getTestApp());
    const cookie = await createGodSession(app, db);
    health = async () =>
      (await app.request('/api/health/tenant_rls', { headers: { cookie } })).json() as never;
    await cleanup();
    // `tenant_id integer`: the reconcile's `SET DEFAULT <uuid>` is refused, so
    // this table's policy cannot be rewritten.
    await Bun.write(
      `${DIR}/001_bad.sql`,
      `CREATE TABLE ${BAD_TABLE} (id serial PRIMARY KEY, tenant_id integer);
       CREATE POLICY tenant_isolation_${BAD_TABLE} ON ${BAD_TABLE} USING (true) WITH CHECK (true);`,
    );
    await Bun.write(
      `${DIR}/001_mid.sql`,
      `-- NO TRANSACTION
CREATE TABLE IF NOT EXISTS ${MID_TABLE} (id serial PRIMARY KEY, tenant_id uuid);
CREATE POLICY tenant_isolation_${MID_TABLE} ON ${MID_TABLE}
  USING (zveltio_tenant_scope_ok(tenant_id)) WITH CHECK (zveltio_tenant_scope_ok(tenant_id));
SELECT 1 / 0;`,
    );
    await Bun.write(
      `${DIR}/001_rst.sql`,
      `CREATE TABLE ${RST_TABLE} (id serial PRIMARY KEY, tenant_id integer);
       CREATE POLICY tenant_isolation_${RST_TABLE} ON ${RST_TABLE} USING (true) WITH CHECK (true);`,
    );
  }, 60_000);

  afterAll(async () => {
    if (db) await cleanup().catch(() => undefined);
    await Bun.$`rm -rf ${DIR}`.quiet().nothrow();
  });

  it('refuses the load and reports the table in /health while its policy stays permissive', async () => {
    const err = await runExtensionMigrations(ext(BAD, '001_bad.sql'), db).then(
      () => null,
      (e: unknown) => e as Error,
    );
    // null is the defect: the extension loaded on a WITH CHECK of `true`.
    expect(err?.message).toContain(BAD);
    expect(err?.message).toContain(BAD_TABLE);
    expect(await withCheck(BAD_TABLE)).toBe('true');
    const noted = (await health()).detail?.failed.find((f) => f.table === BAD_TABLE);
    expect(noted?.error).toContain(BAD);

    // Retried with nothing left to migrate: still refused, not loaded.
    await expect(runExtensionMigrations(ext(BAD, '001_bad.sql'), db)).rejects.toThrow(BAD_TABLE);

    // Once the table can take the predicate, the retry applies it and clears the report.
    await sql`ALTER TABLE ${sql.id(BAD_TABLE)} ALTER COLUMN tenant_id TYPE uuid USING NULL`.execute(
      db,
    );
    await runExtensionMigrations(ext(BAD, '001_bad.sql'), db);
    expect(await withCheck(BAD_TABLE)).toContain('zveltio_tenant_write_ok');
    expect((await health()).detail?.failed.map((f) => f.table)).not.toContain(BAD_TABLE);
  }, 60_000);

  it('a NO TRANSACTION migration that throws midway still has its committed policy rewritten', async () => {
    const err = await runExtensionMigrations(ext(MID, '001_mid.sql'), db).then(
      () => null,
      (e: unknown) => e as { errno?: string },
    );
    expect(err?.errno).toBe('22012'); // the migration's own error, not masked
    // `zveltio_tenant_scope_ok` is the defect: the reconcile never ran.
    expect(await withCheck(MID_TABLE)).toContain('zveltio_tenant_write_ok');
  }, 60_000);

  it('stays refused after a restart, when nothing is left to migrate and memory is gone', async () => {
    await expect(runExtensionMigrations(ext(RST, '001_rst.sql'), db)).rejects.toThrow(RST_TABLE);
    // A restart: the migration row and the permissive policy are on disk, the
    // runner's memory of the refusal is not. A second module instance is that.
    const spec = '../../lib/extensions/migration-runner.js?restart';
    const fresh = (await import(spec)) as typeof import('../../lib/extensions/migration-runner.js');
    expect(fresh.runExtensionMigrations).not.toBe(runExtensionMigrations);
    // Resolving is the defect: the extension loads on a WITH CHECK of `true`.
    await expect(fresh.runExtensionMigrations(ext(RST, '001_rst.sql'), db)).rejects.toThrow(
      RST_TABLE,
    );
    expect(await withCheck(RST_TABLE)).toBe('true');

    await sql`ALTER TABLE ${sql.id(RST_TABLE)} ALTER COLUMN tenant_id TYPE uuid USING NULL`.execute(
      db,
    );
    await fresh.runExtensionMigrations(ext(RST, '001_rst.sql'), db);
    expect(await withCheck(RST_TABLE)).toContain('zveltio_tenant_write_ok');
  }, 60_000);
});
