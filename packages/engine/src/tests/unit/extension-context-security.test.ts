/**
 * createRestrictedDb security policy (lib/extensions/extension-context.ts).
 *
 * The policy is checked on the compiled statement, at execution, over a real
 * Kysely (`CannedDb`) — so "refused" means the driver never saw the query, and
 * "allowed" means it did. One rule for every way an extension can build SQL:
 * collections (`zvd_*` minus the engine's metadata), the extension's own
 * `zv_<ext>_*` namespace, and tables a grant names.
 *
 * It used to be a check on the table NAME handed to `selectFrom` & co., plus a
 * wrapper reading join names. Measured against that guard on a real database,
 * an extension with no grant read `"user"` and `session` through a `sql`
 * fragment in `.where()`, through `with()`, `selectNoFrom()`,
 * `deleteFrom().using()` and `updateTable().from()`, and read the engine's
 * `zvd_permissions` that its raw SQL was refused. The cases below are those.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import {
  createRestrictedDb,
  ExtensionSecurityError,
} from '../../lib/extensions/extension-context.js';
import { CannedDb } from './fixtures/canned-db.js';

type AnyDb = any;

let canned: CannedDb;
beforeEach(() => {
  canned = new CannedDb();
});
const rdb = (ext = 'forms', grants?: string[]): AnyDb =>
  createRestrictedDb(canned.kysely as never, ext, grants ? new Set(grants) : undefined);

/** Refused before the driver saw it, naming the table. */
async function refused(run: Promise<unknown>, table: string): Promise<void> {
  const sentBefore = canned.log.length;
  const err = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ExtensionSecurityError);
  expect((err as Error).message).toMatch(new RegExp(`attempted to access [^.]*\\b${table}\\b`));
  // The engine's own metadata read for a collection write may run; the refused
  // statement may not.
  expect(canned.log.slice(sentBefore).filter((q) => q.sql.includes(`"${table}"`))).toEqual([]);
}

/** Reached the driver. */
async function allowed(run: Promise<unknown>, sent: RegExp): Promise<void> {
  await run;
  expect(canned.executed(sent)).toHaveLength(1);
}

describe('createRestrictedDb — table access policy', () => {
  it('allows collections, its own namespace (slashes folded) and a grant', async () => {
    await allowed(rdb().selectFrom('zvd_contacts').selectAll().execute(), /from "zvd_contacts"/);
    await allowed(
      rdb('my-forms').selectFrom('zv_my_forms_config').selectAll().execute(),
      /from "zv_my_forms_config"/,
    );
    await allowed(
      rdb('compliance/ro/saft').selectFrom('zv_compliance_ro_saft_exports').selectAll().execute(),
      /from "zv_compliance_ro_saft_exports"/,
    );
    // `content/media` owns `zv_media_folders` and the engine's 001 still creates it.
    await allowed(
      rdb('forms', ['zv_media_folders']).selectFrom('zv_media_folders').selectAll().execute(),
      /from "zv_media_folders"/,
    );
  });

  it('refuses the unprefixed Better-Auth tables, which have no RLS', async () => {
    for (const table of ['user', 'session', 'account', 'verification', 'twoFactor']) {
      await refused(rdb().selectFrom(table).selectAll().execute(), table.toLowerCase());
    }
  });

  it("refuses engine tables, zv_* and zvd_* metadata alike, aliased or not, and another extension's", async () => {
    await refused(rdb().selectFrom('zv_api_keys').selectAll().execute(), 'zv_api_keys');
    await refused(rdb('my-ext').selectFrom('zv_tenants as t').selectAll().execute(), 'zv_tenants');
    await refused(rdb().selectFrom('zvd_permissions').selectAll().execute(), 'zvd_permissions');
    await refused(rdb().selectFrom('zvd_collections').selectAll().execute(), 'zvd_collections');
    await refused(rdb().selectFrom('zvd_relations').selectAll().execute(), 'zvd_relations');
    await refused(rdb('forms').selectFrom('zv_crm_deals').selectAll().execute(), 'zv_crm_deals');
  });

  it('refuses a forbidden table wherever the builder puts it', async () => {
    const db = rdb();
    // JOINs, plain and derived.
    await refused(
      db
        .selectFrom('zvd_contacts')
        .innerJoin('session', 'session.userId', 'zvd_contacts.id')
        .selectAll()
        .execute(),
      'session',
    );
    await refused(
      db
        .selectFrom('zvd_contacts')
        .leftJoin((eb: AnyDb) => eb.selectFrom('session').select('token').as('s'), 'x', 'y')
        .selectAll()
        .execute(),
      'session',
    );
    // A list or a derived table at FROM.
    await refused(db.selectFrom(['zvd_contacts', 'session']).selectAll().execute(), 'session');
    await refused(
      db
        .selectFrom((eb: AnyDb) => eb.selectFrom('session').selectAll().as('s'))
        .selectAll()
        .execute(),
      'session',
    );
    // A raw fragment inside a permitted query.
    await refused(
      db.selectFrom('zvd_contacts').selectAll().where(sql`exists (select 1 from "user")`).execute(),
      'user',
    );
    // Entry points the name check never wrapped.
    await refused(
      db
        .with('u', (qc: AnyDb) => qc.selectFrom('user').select('email'))
        .selectFrom('u')
        .selectAll()
        .execute(),
      'user',
    );
    await refused(
      db
        .withRecursive('u', (qc: AnyDb) => qc.selectFrom('user').select('email'))
        .selectFrom('u')
        .selectAll()
        .execute(),
      'user',
    );
    await refused(
      db.selectNoFrom((eb: AnyDb) => eb.selectFrom('session').select('token').as('t')).execute(),
      'session',
    );
    await refused(
      db.deleteFrom('zvd_contacts').using('session').where(sql`false`).execute(),
      'session',
    );
    await refused(
      db.updateTable('zvd_contacts').set({ a: 1 }).from('account').where(sql`false`).execute(),
      'account',
    );
    await refused(
      db
        .mergeInto('zvd_contacts')
        .using('session', (j: AnyDb) => j.on(sql`false`))
        .whenMatched()
        .thenDelete()
        .execute(),
      'session',
    );
    await refused(db.replaceInto('zv_api_keys').values({ a: 1 }).execute(), 'zv_api_keys');
  });

  it('allows the same shapes over permitted tables', async () => {
    const db = rdb('forms', ['zv_form_submissions']);
    await allowed(
      db
        .selectFrom('zvd_contacts')
        .innerJoin('zvd_orders', 'zvd_orders.contactId', 'zvd_contacts.id')
        .leftJoin(
          (eb: AnyDb) => eb.selectFrom('zv_form_submissions').select('form_id').as('sc'),
          'sc.form_id',
          'zvd_contacts.id',
        )
        .selectAll()
        .execute(),
      /left join \(select "form_id" from "zv_form_submissions"\)/,
    );
    canned.log.length = 0;
    await allowed(
      db
        .with('recent', (qc: AnyDb) => qc.selectFrom('zvd_orders').select('id'))
        .selectFrom('recent')
        .selectAll()
        .execute(),
      /^with "recent" as/,
    );
  });

  it('withSchema: public only, and the table after it is still checked', async () => {
    await allowed(
      rdb().withSchema('public').selectFrom('zvd_contacts').selectAll().execute(),
      /from "public"."zvd_contacts"/,
    );
    await refused(
      rdb().withSchema('public').selectFrom('session').selectAll().execute(),
      'session',
    );
    for (const schema of ['information_schema', 'pg_catalog', 'other_tenant', 'zvd_public']) {
      await refused(
        rdb().withSchema(schema).selectFrom('zvd_contacts').selectAll().execute(),
        `${schema}.zvd_contacts`,
      );
    }
  });

  it('refuses the handles the allowlist cannot see into', () => {
    for (const handle of ['connection', 'withPlugin', 'withoutPlugins', 'schema']) {
      expect(() => rdb()[handle]).toThrow(ExtensionSecurityError);
    }
  });

  it('resolves the backing db through a function on each query', async () => {
    let resolves = 0;
    const db: AnyDb = createRestrictedDb(() => {
      resolves++;
      return canned.kysely as never;
    }, 'ext');
    await db.selectFrom('zvd_a').selectAll().execute();
    await db.selectFrom('zv_ext_b').selectAll().execute();
    expect(resolves).toBe(2);
    expect(canned.log.map((q) => q.sql)).toEqual([
      'select * from "zvd_a"',
      'select * from "zv_ext_b"',
    ]);
  });
});

describe('createRestrictedDb — proxy forwarding', () => {
  it('returns non-function properties and binds other methods to the backing database', async () => {
    let destroyed = false;
    const db: AnyDb = createRestrictedDb(
      {
        dialect: 'postgres',
        destroy: async () => {
          destroyed = true;
        },
      } as never,
      'ext',
    );
    expect(db.dialect).toBe('postgres');
    await db.destroy();
    expect(destroyed).toBe(true);
  });
});
