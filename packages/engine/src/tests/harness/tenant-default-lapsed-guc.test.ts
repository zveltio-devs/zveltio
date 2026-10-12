/**
 * An INSERT with no tenant context — a fresh pooled connection, or one whose
 * `SET LOCAL zveltio.current_tenant` has lapsed to '' after COMMIT — can land in
 * the default tenant and nowhere else.
 *
 * Every `tenant_id` column default falls back to the default tenant when the
 * setting is absent or empty. That is deliberate, and it is safe only while the
 * write half of the policy agrees with it: `zveltio_tenant_write_ok` admits the
 * default tenant and nothing else without a context, and nothing at all when
 * `zveltio.fail_closed_tenant` is on. So a lapsed connection cannot be told apart
 * from a fresh one, a contextless writer that names another tenant is refused
 * rather than re-homed, and the fail-closed install refuses the write outright.
 *
 * Driven through a one-connection pool opened as `zveltio_rls`, so the second
 * statement runs on the very connection the first transaction committed on —
 * the harness pool is a superuser, where no policy binds.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Kysely, sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { BunSqlDialect } from '../../db/bun-sql-dialect.js';
import type { DbSchema } from '../../db/schema.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const ROOT = '00000000-0000-0000-0000-000000000001';
const OTHER = crypto.randomUUID();
const STAMP = `lapsed_${Date.now()}`;

function rlsUrl(): string {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.searchParams.set('options', '-c role=zveltio_rls');
  return url.toString();
}

/** SQLSTATE of a refused statement (Bun.SQL puts it in `errno`). */
const sqlstate = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { errno?: string }) => e.errno ?? 'error',
  );

d('tenant_id default on a connection with no tenant context', () => {
  let db: Database;
  let one: Database;

  const setting = async () =>
    (
      await sql<{ v: string | null }>`
        SELECT current_setting('zveltio.current_tenant', true) AS v`.execute(one)
    ).rows[0]!.v;

  /** Leaves `one`'s only connection with the setting emptied by a COMMIT. */
  const lapse = () =>
    one.transaction().execute(async (trx) => {
      await sql`SELECT set_config('zveltio.current_tenant', ${OTHER}, true)`.execute(trx);
    });

  const insertBare = (name: string, conn: Database = one) =>
    sql<{ tenant_id: string }>`
      INSERT INTO zv_media_tags (name) VALUES (${name}) RETURNING tenant_id::text AS tenant_id
    `.execute(conn);

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${OTHER}::uuid, ${STAMP}, ${STAMP}, 'active')`.execute(db);
    one = new Kysely<DbSchema>({
      dialect: new BunSqlDialect({ connectionString: rlsUrl(), max: 1 }),
    }) as unknown as Database;
  }, 60_000);

  afterAll(async () => {
    await one?.destroy().catch(() => undefined);
    if (!db) return;
    await sql`DELETE FROM zv_media_tags WHERE name LIKE ${`${STAMP}%`}`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER}::uuid`.execute(db);
  });

  it('a lapsed setting is empty, and the insert lands in the default tenant', async () => {
    await lapse();
    expect(await setting()).toBe('');
    const r = await insertBare(`${STAMP}-lapsed`);
    expect(r.rows[0]!.tenant_id).toBe(ROOT);
  });

  it('is never visible to the tenant whose transaction the connection last served', async () => {
    await lapse();
    await insertBare(`${STAMP}-unseen`);
    const asOther = await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('zveltio.current_tenant', ${OTHER}, true)`.execute(trx);
      await sql`SET LOCAL ROLE zveltio_rls`.execute(trx);
      return sql<{ n: number }>`
        SELECT count(*)::int AS n FROM zv_media_tags WHERE name = ${`${STAMP}-unseen`}`.execute(
        trx,
      );
    });
    expect(asOther.rows[0]!.n).toBe(0);
  });

  it('a contextless writer that names another tenant is refused, not re-homed', async () => {
    await lapse();
    const state = await sqlstate(
      sql`INSERT INTO zv_media_tags (name, tenant_id)
          VALUES (${`${STAMP}-named`}, ${OTHER}::uuid)`.execute(one),
    );
    expect(state).toBe('42501');
  });

  it('a fresh connection behaves exactly as a lapsed one', async () => {
    const fresh = new Kysely<DbSchema>({
      dialect: new BunSqlDialect({ connectionString: rlsUrl(), max: 1 }),
    }) as unknown as Database;
    try {
      const v = await sql<{ v: string | null }>`
        SELECT current_setting('zveltio.current_tenant', true) AS v`.execute(fresh);
      expect(['', null]).toContain(v.rows[0]!.v);
      const r = await insertBare(`${STAMP}-fresh`, fresh);
      expect(r.rows[0]!.tenant_id).toBe(ROOT);
    } finally {
      await fresh.destroy();
    }
  });

  it('with fail-closed tenancy on, the contextless insert is refused', async () => {
    await lapse();
    const state = await sqlstate(
      one.transaction().execute(async (trx) => {
        await sql`SELECT set_config('zveltio.fail_closed_tenant', 'on', true)`.execute(trx);
        await sql`INSERT INTO zv_media_tags (name) VALUES (${`${STAMP}-closed`})`.execute(trx);
      }),
    );
    expect(state).toBe('42501');
  });
});
