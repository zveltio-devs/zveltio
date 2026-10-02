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

  const refused = (p: Promise<unknown>, table: string) =>
    expect(p).rejects.toThrow(new RegExp(`attempted to access [^.]*\\b${table}\\b`));

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
        expect(() => trx.selectFrom('session' as never)).toThrow(ExtensionSecurityError);
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
