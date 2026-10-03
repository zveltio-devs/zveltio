/**
 * Raw SQL from an inline extension meets the same table allowlist as its query
 * builder calls.
 *
 * `createRestrictedDb` checked the table NAME handed to `selectFrom` & co. and
 * nothing else: `sql\`SELECT token FROM "session"\`.execute(ctx.db)` asked the
 * proxy for `getExecutor()`, got the real one, and Postgres answered — so an
 * extension refused `ctx.db.selectFrom('session')` read the same bearer tokens
 * one line later. The rule is now the worker bridge's analyzer
 * (`assertWorkerSqlAllowed`) with the extension's grants: collections, its own
 * `zv_<ext>_*` namespace, and the tables its migrations create or a grant names.
 *
 * Engine helpers handed to extensions (`ctx.DDLManager`, `dynamicInsert`) run
 * their own catalogue SQL on the handle the extension passes; that SQL is the
 * engine's and keeps working, while a table the EXTENSION chooses is still
 * checked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { _resetExtensionDbRoleForTests } from '../../lib/extensions/ext-db-role.js';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { dynamicInsert } from '../../db/dynamic.js';
import {
  ExtensionSecurityError,
  createRestrictedDb,
} from '../../lib/extensions/extension-context.js';
import { buildExtensionInternals, type ExtensionContext } from '../../lib/extensions/internals.js';
import { buildRestrictedContext } from '../../lib/extensions/register.js';
import { getCurrentTenantTrx } from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT = '00000000-0000-0000-0000-000000000001';
const EXT = 'rawprobe';
const OWN = 'zv_rawprobe_notes'; // the extension's own namespace
const GRANTED = 'zv_rawprobe_grant_target'; // outside it, reachable only by grant
const COLLECTION = 'zvd_rawprobe_things';

d('raw SQL from an inline extension', () => {
  let db: Database;
  let ext: Database;

  beforeAll(async () => {
    // The role ctx.db runs as is process state a file that loaded an extension
    // leaves on. This file builds ctx.db without load.ts' grant step, so it
    // tests the analyzer alone; extension-db-role.test.ts tests the role.
    _resetExtensionDbRoleForTests();
    db = (await getTestApp()).db;
    for (const t of [OWN, GRANTED, COLLECTION]) {
      await sql`CREATE TABLE IF NOT EXISTS ${sql.table(t)} (id serial PRIMARY KEY, note text, meta jsonb)`.execute(
        db,
      );
    }
    // The grant names a table outside the namespace, as EXTENSION_TABLE_GRANTS does.
    ext = createRestrictedDb(() => getCurrentTenantTrx() ?? db, EXT, new Set([GRANTED]));
  });

  afterAll(async () => {
    for (const t of [OWN, GRANTED, COLLECTION]) {
      await sql`DROP TABLE IF EXISTS ${sql.table(t)}`.execute(db);
    }
  });

  // Through an async function: the old builder guard handed back its promise
  // wrapped in a Proxy, which `expect().rejects` does not accept as a promise.
  const refused = (p: PromiseLike<unknown>, table: string) =>
    expect((async () => p)()).rejects.toThrow(
      new RegExp(`attempted to access [^.]*\\b${table}\\b`),
    );

  it('refuses the Better-Auth tables', async () => {
    await refused(sql`SELECT token FROM "session" LIMIT 1`.execute(ext), 'session');
    await refused(sql`SELECT email FROM "user" LIMIT 1`.execute(ext), 'user');
    await refused(sql.raw('SELECT password FROM account LIMIT 1').execute(ext), 'account');
    await expect(sql`SELECT 1 FROM "user"`.execute(ext)).rejects.toBeInstanceOf(
      ExtensionSecurityError,
    );
  });

  it('refuses the engine tables, zv_* and zvd_* metadata alike, and the catalogue', async () => {
    await refused(sql`SELECT key_hash FROM zv_api_keys`.execute(ext), 'zv_api_keys');
    await refused(sql`SELECT * FROM zvd_permissions`.execute(ext), 'zvd_permissions');
    await refused(
      sql`SELECT table_name FROM information_schema.tables`.execute(ext),
      'information_schema.tables',
    );
  });

  it('refuses the other ways raw SQL reaches the executor', async () => {
    const asCompiled = { sql: 'SELECT token FROM session', parameters: [], query: {} };
    await refused(ext.executeQuery(asCompiled as never), 'session');
    await refused(ext.getExecutor().executeQuery(asCompiled as never), 'session');
    // A joined transaction's callback used to receive the bare transaction.
    await buildExtensionInternals().withTenantIsolation(TENANT, () =>
      ext.transaction().execute(async (trx) => {
        await refused(sql`SELECT token FROM "session"`.execute(trx), 'session');
        await refused(
          trx
            .selectFrom('session' as never)
            .selectAll()
            .execute(),
          'session',
        );
      }),
    );
    expect(() => ext.connection()).toThrow(ExtensionSecurityError);
  });

  it('allows its own namespace, a granted table and collections', async () => {
    await sql`INSERT INTO ${sql.table(OWN)} (note) VALUES ('own')`.execute(ext);
    await sql`INSERT INTO ${sql.table(GRANTED)} (note) VALUES ('granted')`.execute(ext);
    const r = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.table(COLLECTION)} c
        JOIN ${sql.table(OWN)} o ON o.note = c.note`.execute(ext);
    expect(r.rows[0]!.n).toBe(0);
    await buildExtensionInternals().withTenantIsolation(TENANT, () =>
      ext.transaction().execute((trx) => sql`SELECT note FROM ${sql.table(GRANTED)}`.execute(trx)),
    );
  });

  // The query builder used to check only the table NAME handed to `selectFrom` &
  // co.; everything else it can express reached Postgres unread. It now runs the
  // same analyzer on the SQL it compiles, so these are refused like raw SQL.
  it('refuses through the query builder what it refuses as raw SQL', async () => {
    const tx = ext as unknown as {
      selectFrom: (t: string) => any;
      selectNoFrom: (f: (eb: any) => unknown) => any;
      with: (n: string, f: (qc: any) => unknown) => any;
      deleteFrom: (t: string) => any;
      updateTable: (t: string) => any;
    };
    // (a) a raw fragment inside a permitted builder query
    await refused(
      tx.selectFrom(COLLECTION).select('id').where(sql`exists (select 1 from "user")`).execute(),
      'user',
    );
    await refused(
      tx.selectFrom(COLLECTION).select(sql`(select token from session limit 1)`.as('t')).execute(),
      'session',
    );
    // (b) entry points the guard never wrapped
    await refused(
      tx
        .with('u', (qc) => qc.selectFrom('user').select('email'))
        .selectFrom('u')
        .selectAll()
        .execute(),
      'user',
    );
    await refused(
      tx.selectNoFrom((eb) => eb.selectFrom('session').select('token').limit(1).as('t')).execute(),
      'session',
    );
    await refused(
      tx.deleteFrom(COLLECTION).using('session').where(sql`false`).execute(),
      'session',
    );
    await refused(
      tx.updateTable(COLLECTION).set({ note: 'x' }).from('account').where(sql`false`).execute(),
      'account',
    );
    // (c) the engine's zvd_* metadata, which the raw path already refused
    await refused(tx.selectFrom('zvd_permissions').selectAll().execute(), 'zvd_permissions');
    await refused(tx.selectFrom('zvd_collections').selectAll().execute(), 'zvd_collections');
    await refused(tx.selectFrom('zvd_relations').selectAll().execute(), 'zvd_relations');
    // and inside a joined transaction
    await buildExtensionInternals().withTenantIsolation(TENANT, () =>
      ext.transaction().execute(async (trx) => {
        await refused(
          (trx as unknown as typeof tx)
            .selectFrom(OWN)
            .select('id')
            .where(sql`exists (select 1 from "session")`)
            .execute(),
          'session',
        );
      }),
    );
  });

  it('still allows the builder its own namespace, a grant, collections and transaction()', async () => {
    const tx = ext as unknown as {
      selectFrom: (t: string) => any;
      insertInto: (t: string) => any;
      with: (n: string, f: (qc: any) => unknown) => any;
    };
    await tx.insertInto(OWN).values({ note: 'b-own' }).execute();
    await tx.insertInto(COLLECTION).values({ note: 'b-own' }).execute();
    const joined = await tx
      .selectFrom(`${COLLECTION} as c`)
      .innerJoin(`${OWN} as o`, 'o.note', 'c.note')
      .leftJoin((eb: any) => eb.selectFrom(GRANTED).select('note').as('g'), 'g.note', 'c.note')
      .select('c.note')
      .execute();
    expect(joined.map((r: { note: string }) => r.note)).toContain('b-own');
    const cte = await tx
      .with('recent', (qc) => qc.selectFrom(COLLECTION).select('note'))
      .selectFrom('recent')
      .selectAll()
      .execute();
    expect(cte.length).toBeGreaterThan(0);
    await buildExtensionInternals().withTenantIsolation(TENANT, () =>
      ext.transaction().execute(async (trx) => {
        await (trx as unknown as typeof tx)
          .insertInto(GRANTED)
          .values({ note: 'in-trx' })
          .execute();
        const r = await (trx as unknown as typeof tx).selectFrom(GRANTED).select('note').execute();
        expect(r.map((x: { note: string }) => x.note)).toContain('in-trx');
      }),
    );
  });

  // The table allowlist read the tables a statement NAMED in a FROM/JOIN/INTO
  // position, and nothing else: DDL, TRUNCATE, GRANT, `TABLE x`, `SET` and the
  // GUC-changing functions name a table elsewhere or not at all, and Postgres ran
  // them as the engine role. Each must be refused, on the pool and inside the
  // request transaction alike, before it reaches the database.
  it('refuses every statement kind but DML, and the functions that leave the sandbox', async () => {
    const statements = [
      'TABLE session',
      'SELECT EXISTS (TABLE session)',
      `TRUNCATE ${COLLECTION}`,
      `COMMENT ON TABLE ${OWN} IS 'x'`,
      'GRANT SELECT ON "session" TO PUBLIC',
      `ALTER TABLE ${OWN} DISABLE ROW LEVEL SECURITY`,
      `CREATE TABLE ${OWN}_made (id int)`,
      `DROP TABLE IF EXISTS ${OWN}_absent`,
      `SELECT * INTO ${OWN}_copy FROM ${OWN}`,
      'SET LOCAL zveltio.rls_bypass = on',
      'RESET ALL',
      'SELECT 1; SELECT 2',
      // Where the scan and Postgres disagreed on where a string ends, the scan
      // blanked SQL that Postgres ran.
      `SELECT E'\\'', (SELECT token FROM "session" LIMIT 1) AS t, ''`,
      'SELECT x$$, (SELECT token FROM "session" LIMIT 1) AS t --$$\n FROM (SELECT 1 AS "x$$") s',
      "SELECT set_config('zveltio.rls_bypass', 'on', true)",
      "SELECT pg_catalog.set_config('role', 'none', true)",
      "SELECT query_to_xml('select 1', true, false, '')",
      "SELECT pg_notify('zveltio_cache', 'x')",
      `VACUUM ${OWN}`,
    ];
    const accepted: string[] = [];
    const probe = async (where: string, run: (s: string) => Promise<unknown>) => {
      for (const s of statements) {
        try {
          await run(s);
          accepted.push(`${where}: ${s}`);
        } catch (err) {
          if (!(err instanceof ExtensionSecurityError)) {
            accepted.push(`${where}: ${s} (reached Postgres)`);
          }
        }
      }
    };
    await probe('pool', (s) => sql.raw(s).execute(ext));
    await buildExtensionInternals().withTenantIsolation(TENANT, () =>
      // Each in its own savepoint, so one statement Postgres rejects does not
      // abort the rest of the probe with 25P02.
      probe('trx', (s) => ext.transaction().execute((trx) => sql.raw(s).execute(trx))),
    );
    expect(accepted).toEqual([]);
  });

  it('still allows DML in every form ctx.db compiles it to', async () => {
    const tx = ext as unknown as {
      mergeInto: (t: string) => any;
      selectFrom: (t: string) => any;
    };
    const ins = await sql<{ id: number }>`
      WITH w AS (INSERT INTO ${sql.table(OWN)} (note) VALUES ('kinds') RETURNING id)
      SELECT id FROM w`.execute(ext);
    expect(ins.rows).toHaveLength(1);
    await sql`(SELECT note FROM ${sql.table(OWN)}) UNION ALL (VALUES ('v'))`.execute(ext);
    expect((await sql.raw('VALUES (1), (2)').execute(ext)).rows).toHaveLength(2);
    await tx
      .mergeInto(`${OWN} as t`)
      .using(`${GRANTED} as s`, 's.note', 't.note')
      .whenMatched()
      .thenUpdateSet({ note: 'merged' })
      .execute();
    // A column aliased `table` is a label, not a table reference.
    await tx.selectFrom(OWN).select(sql`1`.as('table')).execute();
    // current_setting reads the GUCs the engine set; reading is not changing.
    await sql`SELECT current_setting('zveltio.current_tenant', true)`.execute(ext);
    // BEGIN/COMMIT are the engine's, on its own handle: transaction() still works
    // on the pool, where Kysely opens a real one.
    const n = await ext
      .transaction()
      .execute((trx) =>
        sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(OWN)}`.execute(trx),
      );
    expect(n.rows[0]!.n).toBeGreaterThan(0);
  });

  it("keeps the engine's own SQL working on the handle an extension passes", async () => {
    const ctx = buildRestrictedContext(
      { db } as unknown as ExtensionContext,
      EXT,
      new Hono(),
      new Set([GRANTED]),
      false,
    );
    // pg_tables, read by the engine on ctx.db.
    expect(await ctx.DDLManager.tableExists(ctx.db, 'rawprobe_things')).toBe(true);
    // information_schema (the jsonb probe), then an INSERT into a collection.
    const row = await dynamicInsert(ctx.db, COLLECTION, { note: 'helper', meta: { a: 1 } });
    expect(row.meta).toEqual({ a: 1 });
    // The INSERT names the extension's table, so it is still the extension's to pass.
    await refused(dynamicInsert(ctx.db, 'session', { token: 'x' }), 'session');
  });
});
