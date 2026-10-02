/**
 * A `unique: true` field is unique per tenant, on every road a column is born.
 *
 * Every `zvd_*` table carries `tenant_id` and is FORCE-RLS'd on it, but the
 * column builder wrote a column-level `UNIQUE`, i.e. `UNIQUE (code)` across the
 * whole table. Tenant B could not take a value tenant A held, was refused over a
 * row RLS hides from it, and could probe for another company's emails or codes
 * through the refusal. The key is `UNIQUE (tenant_id, code)` now — on create,
 * on the DDL-queue addField, on the add-field route and on a schema-branch merge.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { sql } from 'kysely';
import type { Hono } from 'hono';
import { createDb, type Database } from '../../db/index.js';
import {
  DDLManager,
  reconcileUniqueKeys,
  type UniqueKeyReconcileResult,
} from '../../lib/data/index.js';
import {
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT_A = '00000000-0000-0000-0000-000000000001';
const TENANT_B = '00000000-0000-0000-0000-0000000000fe';
const SFX = Date.now();
const COLLECTION = `uniq_tenant_${SFX}`;
const TABLE = `zvd_${COLLECTION}`;
const LEGACY = `uniq_legacy_${SFX}`;
const FK = `uniq_fk_${SFX}`;
const FK_REF = `zvd_uniq_fkref_${SFX}`;
const BROKEN = `uniq_broken_${SFX}`;
const BYOD = `uniq_byod_${SFX}`;
const SLOW = `uniq_slow_${SFX}`;
const PARTIAL = `uniq_partial_${SFX}`;
const NULLABLE = `uniq_nullable_${SFX}`;
/** A `zvd_*` table no collection owns — an extension's, with its own key. */
const FOREIGN = `zvd_uniq_ext_${SFX}`;

const field = (name: string, unique: boolean) => ({
  name,
  type: 'text',
  required: false,
  unique,
  indexed: false,
});

d('a unique field is unique per tenant', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  /** Inserts `value` into `column` as `tenant`; returns the SQLSTATE or 'ok'. */
  const put = async (column: string, value: string, tenant: string): Promise<string> => {
    try {
      await sql`
        INSERT INTO ${sql.id(TABLE)} (${sql.id(column)}, tenant_id) VALUES (${value}, ${tenant}::uuid)
      `.execute(db);
      return 'ok';
    } catch (err) {
      return String((err as { errno?: string }).errno ?? err);
    }
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);

    // Road 1: createCollection.
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [field('code', true), field('plain', false)],
    } as never);
    // Road 2: the DDL-queue addField.
    await DDLManager.addField(db, COLLECTION, field('ref', true) as never);
    // Road 3: the add-field route.
    const added = await app.request(`/api/collections/${COLLECTION}/fields`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(field('sku', true)),
    });
    expect(added.status).toBeLessThan(300);
    // Road 4: a schema-branch merge (small table: the dynamicAddColumn road).
    const created = await app.request('/api/schema/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: `uniq-${SFX}` }),
    });
    expect(created.status).toBe(201);
    const { branch, schema } = (await created.json()) as { branch: { id: string }; schema: string };
    const change = await app.request(`/api/schema/branches/${branch.id}/changes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        type: 'add_field',
        payload: { collection: COLLECTION, field: field('tag', true) },
      }),
    });
    expect(change.status).toBeLessThan(300);
    const merged = await app.request(`/api/schema/branches/${branch.id}/merge`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(((await merged.json()) as { errors: string[] }).errors).toEqual([]);
    await db.deleteFrom('zv_schema_branches').where('id', '=', branch.id).execute();
    await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(db);
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await dropTestCollection(db, COLLECTION);
    await dropTestCollection(db, LEGACY);
    await sql`DROP TABLE IF EXISTS ${sql.id(FOREIGN)}`.execute(db);
  });

  for (const column of ['code', 'ref', 'sku', 'tag']) {
    it(`${column}: the same value in two tenants is two rows, twice in one tenant is refused`, async () => {
      expect(await put(column, 'X-1', TENANT_A)).toBe('ok');
      expect(await put(column, 'X-1', TENANT_B)).toBe('ok');
      expect(await put(column, 'X-1', TENANT_A)).toBe('23505');
      expect(await put(column, 'X-1', TENANT_B)).toBe('23505');
    });
  }

  it('the key is (tenant_id, column), and a non-unique field has none', async () => {
    const keys = await sql<{ def: string }>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = ${TABLE}::regclass AND contype = 'u' ORDER BY 1
    `.execute(db);
    expect(keys.rows.map((r) => r.def)).toEqual([
      'UNIQUE (tenant_id, code)',
      'UNIQUE (tenant_id, ref)',
      'UNIQUE (tenant_id, sku)',
      'UNIQUE (tenant_id, tag)',
    ]);
  });

  it('a duplicate through the API names the field, not the tenant', async () => {
    const post = () =>
      app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ code: 'API-1' }),
      });
    expect((await post()).status).toBe(201);
    const dup = await post();
    expect(dup.status).toBe(409);
    // The problem envelope carries the mapped message. Before, the key was
    // global, and widened to `(tenant_id, code)` without the mapper knowing,
    // it read "the same tenant_id, code … (value: <tenant uuid>, API-1)".
    const body = (await dup.json()) as { errors?: string[] };
    expect(body.errors).toEqual(['A record with the same code already exists (value: API-1).']);
  });

  // What every build before this one wrote for a unique field, and what the
  // boot reconciler has to turn into `(tenant_id, column)` on its own.
  describe('the boot reconciler', () => {
    const legacy = `zvd_${LEGACY}`;
    const keys = async (table: string) =>
      (
        await sql<{ def: string }>`
          SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = ${table}::regclass AND contype = 'u' ORDER BY 1
        `.execute(db)
      ).rows.map((r) => r.def);
    const uniqueIndexes = async (table: string) =>
      (
        await sql<{ def: string }>`
          SELECT pg_get_indexdef(indexrelid) AS def FROM pg_index
          WHERE indrelid = ${table}::regclass AND indisunique AND NOT indisprimary ORDER BY 1
        `.execute(db)
      ).rows
        .map((r) => r.def.replace(/^.* USING btree /, ''))
        .sort();
    const mine = (r: UniqueKeyReconcileResult | null) => ({
      fixed: (r?.fixed ?? []).filter((k) => k.includes(String(SFX))),
      skipped: (r?.skipped ?? []).filter((s) => s.key.includes(String(SFX))),
    });
    let first: UniqueKeyReconcileResult | null = null;
    const warn = spyOn(console, 'warn');

    beforeAll(async () => {
      // A unique constraint, a unique index with no constraint, and a column
      // that carries both the old key and the new one.
      await DDLManager.createCollection(db, {
        name: LEGACY,
        fields: [field('email', false), field('slug', false), field('ref', false)],
      } as never);
      await sql`ALTER TABLE ${sql.id(legacy)} ADD UNIQUE (email), ADD UNIQUE (ref)`.execute(db);
      await sql`ALTER TABLE ${sql.id(legacy)} ADD UNIQUE (tenant_id, ref)`.execute(db);
      await sql`CREATE UNIQUE INDEX ${sql.id(`${legacy}_slug_uidx`)} ON ${sql.id(legacy)} (slug)`.execute(
        db,
      );

      // A key a foreign key points at cannot be dropped.
      await DDLManager.createCollection(db, { name: FK, fields: [field('code', false)] } as never);
      await sql`ALTER TABLE ${sql.id(`zvd_${FK}`)} ADD UNIQUE (code)`.execute(db);
      await sql`
        CREATE TABLE ${sql.id(FK_REF)} (code text REFERENCES ${sql.id(`zvd_${FK}`)} (code))
      `.execute(db);

      // A CONCURRENTLY build that died, under the name the reconciler builds.
      await DDLManager.createCollection(db, {
        name: BROKEN,
        fields: [field('code', false)],
      } as never);
      const broken = `zvd_${BROKEN}`;
      await sql`ALTER TABLE ${sql.id(broken)} ADD UNIQUE (code)`.execute(db);
      for (const code of ['a', 'b']) {
        await sql`
          INSERT INTO ${sql.id(broken)} (code, tenant_id) VALUES (${code}, ${TENANT_A}::uuid)
        `.execute(db);
      }
      const died = await sql`
        CREATE UNIQUE INDEX CONCURRENTLY ${sql.id(`${broken}_tenant_id_code_key`)}
          ON ${sql.id(broken)} (tenant_id)
      `
        .execute(db)
        .then(() => 'built')
        .catch((err) => String((err as { errno?: string }).errno));
      expect(died).toBe('23505');

      // BYOD: imported and not managed — Zveltio does not ALTER it.
      await DDLManager.createCollection(db, {
        name: BYOD,
        fields: [field('code', false)],
      } as never);
      await sql`ALTER TABLE ${sql.id(`zvd_${BYOD}`)} ADD UNIQUE (code)`.execute(db);
      await db
        .updateTable('zvd_collections')
        .set({ is_managed: false })
        .where('name', '=', BYOD)
        .execute();

      // A partial key is not `(x)`: widening it would drop its WHERE.
      await DDLManager.createCollection(db, {
        name: PARTIAL,
        fields: [field('code', false)],
      } as never);
      await sql`
        CREATE UNIQUE INDEX ${sql.id(`zvd_${PARTIAL}_code_live`)} ON ${sql.id(`zvd_${PARTIAL}`)} (code)
          WHERE code <> ''
      `.execute(db);

      // A NULL tenant_id is distinct from every other: (tenant_id, x) would be looser than (x).
      await DDLManager.createCollection(db, {
        name: NULLABLE,
        fields: [field('code', false)],
      } as never);
      await sql`
        ALTER TABLE ${sql.id(`zvd_${NULLABLE}`)} ALTER COLUMN tenant_id DROP NOT NULL, ADD UNIQUE (code)
      `.execute(db);

      // An extension's own zvd_* table, registered as no collection.
      await sql`
        CREATE TABLE ${sql.id(FOREIGN)} (id uuid PRIMARY KEY, code text UNIQUE, tenant_id uuid NOT NULL)
      `.execute(db);
    }, 60_000);

    afterAll(async () => {
      warn.mockRestore();
      await sql`DROP TABLE IF EXISTS ${sql.id(FK_REF)}`.execute(db);
      for (const c of [FK, BROKEN, BYOD, PARTIAL, NULLABLE]) await dropTestCollection(db, c);
    });

    it('a second instance skips while one holds the lock', async () => {
      await db.transaction().execute(async (other) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext('zveltio:unique-key-reconcile'))`.execute(
          other,
        );
        expect(await reconcileUniqueKeys(db)).toBeNull();
      });
      expect(await keys(legacy)).toContain('UNIQUE (email)');
    });

    it('widens a unique constraint and a unique index to (tenant_id, column)', async () => {
      first = await reconcileUniqueKeys(db);
      expect(mine(first).fixed).toEqual(
        expect.arrayContaining([`${legacy}.email`, `${legacy}.ref`, `${legacy}.slug`]),
      );
      expect(await keys(legacy)).toEqual([
        'UNIQUE (tenant_id, email)',
        'UNIQUE (tenant_id, ref)',
        'UNIQUE (tenant_id, slug)',
      ]);
      // The old keys are gone, not kept beside the new ones.
      expect(await uniqueIndexes(legacy)).toEqual([
        '(tenant_id, email)',
        '(tenant_id, ref)',
        '(tenant_id, slug)',
      ]);
      for (const col of ['email', 'slug']) {
        const ins = (tenant: string) =>
          sql`
            INSERT INTO ${sql.id(legacy)} (${sql.id(col)}, tenant_id) VALUES ('a@x', ${tenant}::uuid)
          `
            .execute(db)
            .then(() => 'ok')
            .catch((err) => String((err as { errno?: string }).errno));
        expect(await ins(TENANT_A)).toBe('ok');
        expect(await ins(TENANT_B)).toBe('ok');
        expect(await ins(TENANT_A)).toBe('23505');
      }
    });

    it('rebuilds an INVALID index a failed build left behind', async () => {
      const broken = `zvd_${BROKEN}`;
      expect(mine(first).fixed).toContain(`${broken}.code`);
      expect(await keys(broken)).toEqual(['UNIQUE (tenant_id, code)']);
      expect(await uniqueIndexes(broken)).toEqual(['(tenant_id, code)']);
    });

    it('keeps a key a foreign key references, and says so', async () => {
      expect(mine(first).skipped).toEqual([
        { key: `zvd_${FK}.code`, reason: 'a foreign key references it' },
      ]);
      expect(warn.mock.calls.some((c) => String(c[0]).includes(`zvd_${FK}.code`))).toBe(true);
      expect(await keys(`zvd_${FK}`)).toEqual(['UNIQUE (code)']);
      expect(await uniqueIndexes(`zvd_${FK}`)).toEqual(['(code)']);
    });

    it('leaves BYOD and extension-owned tables alone', async () => {
      expect(await keys(`zvd_${BYOD}`)).toEqual(['UNIQUE (code)']);
      expect(await keys(FOREIGN)).toEqual(['UNIQUE (code)']);
    });

    it('leaves a partial key and a table whose tenant_id may be NULL alone', async () => {
      expect(await uniqueIndexes(`zvd_${PARTIAL}`)).toEqual(["(code) WHERE (code <> ''::text)"]);
      expect(await keys(`zvd_${NULLABLE}`)).toEqual(['UNIQUE (code)']);
      expect(mine(first).fixed.filter((k) => k.includes(PARTIAL) || k.includes(NULLABLE))).toEqual(
        [],
      );
    });

    it('a second run changes nothing', async () => {
      const again = await reconcileUniqueKeys(db);
      expect(again?.fixed).toEqual([]);
      expect(mine(again).skipped.map((s) => s.key)).toEqual([`zvd_${FK}.code`]);
    });

    it('holds its lock through a build longer than the idle-in-transaction timeout', async () => {
      // The pool kills a transaction idle past this; the lock holder idles for
      // as long as a build takes. 200 ms here, 60 s in production.
      const url = new URL(process.env.TEST_DATABASE_URL as string);
      url.searchParams.set('options', '-c idle_in_transaction_session_timeout=200');
      const short = createDb(url.toString());
      const slow = `zvd_${SLOW}`;
      try {
        await DDLManager.createCollection(db, {
          name: SLOW,
          fields: [field('code', false)],
        } as never);
        await sql`ALTER TABLE ${sql.id(slow)} ADD UNIQUE (code)`.execute(db);
        // An open writer makes CREATE INDEX CONCURRENTLY wait for it — one second.
        let inserted!: () => void;
        const ready = new Promise<void>((r) => {
          inserted = r;
        });
        const writer = db.transaction().execute(async (trx) => {
          await sql`INSERT INTO ${sql.id(slow)} (code, tenant_id) VALUES ('w', ${TENANT_A}::uuid)`.execute(
            trx,
          );
          inserted();
          await Bun.sleep(1000);
        });
        await ready;
        const r = await reconcileUniqueKeys(short);
        await writer;
        expect(mine(r).fixed).toEqual([`${slow}.code`]);
        expect(await keys(slow)).toEqual(['UNIQUE (tenant_id, code)']);
      } finally {
        await short.destroy();
        await dropTestCollection(db, SLOW);
      }
    });
  });
});
