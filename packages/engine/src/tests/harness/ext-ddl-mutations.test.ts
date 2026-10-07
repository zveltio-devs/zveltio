/**
 * Every schema mutation `ctx.DDLManager` hands an extension works from inside
 * the request's tenant transaction, with tenant RLS on or unavailable, on a
 * collection that already exists and holds rows — and what it changed is usable
 * by the extension's next `ctx.db` statement in the same request.
 *
 * Measured before the fix, each ran on the request transaction: as `zveltio_rls`
 * every DDL failed 42501 (not the owner / no CREATE); as the engine's superuser
 * an index build failed 25001 (CONCURRENTLY in a transaction block) and
 * `applyRelationFK` refused the transaction outright.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { isDDLQueueStarted } from '../../lib/data/ddl-queue.js';
import {
  _resetExtensionDbRoleForTests,
  grantExtensionDbRole,
  revokeExtensionDbRoles,
} from '../../lib/extensions/ext-db-role.js';
import { buildExtensionInternals, type ExtensionContext } from '../../lib/extensions/internals.js';
import { buildRestrictedContext } from '../../lib/extensions/register.js';
import { applyTenantRLS } from '../../lib/tenancy/index.js';
import { _setRlsRoleAvailableForTests } from '../../lib/tenancy/tenant-manager.js';
import { withTenantIsolation } from '../../lib/tenancy/index.js';
import {
  ALL_COLLECTIONS_ACTOR,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT = '00000000-0000-0000-0000-000000000001';
const EXT = 'ddlmut';
// Short: junction and index names are built from these and capped at 63 bytes.
const TAG = Date.now() % 1_000_000;
const MODES = ['enforced', 'unavailable'] as const;
type Mode = (typeof MODES)[number];

d("ctx.DDLManager's mutations inside a request", () => {
  let db: Database;
  let ddl: ExtensionContext['DDLManager'];
  let ext: Database;
  const made: string[] = [];

  /** A collection as Studio makes one — on the pool, isolated — with one row. */
  const existing = async (name: string, fields: { name: string; type: string }[]) => {
    made.push(name);
    await DDLManager.createCollection(db, { name, fields } as never);
    await applyTenantRLS(db, `zvd_${name}`);
    await sql`INSERT INTO ${sql.id(`zvd_${name}`)} DEFAULT VALUES`.execute(db);
  };
  /** The tenant middleware's request transaction, in `mode`. */
  const inRequest = async (mode: Mode, fn: () => Promise<void>) => {
    const restore = _setRlsRoleAvailableForTests(mode === 'enforced');
    try {
      await withTenantIsolation(TENANT, fn, { identity: ALL_COLLECTIONS_ACTOR });
    } finally {
      restore();
    }
  };
  const columns = async (table: string) =>
    (
      await sql<{ c: string }>`SELECT attname::text AS c FROM pg_attribute
        WHERE attrelid = ${`public.${table}`}::regclass AND attnum > 0 AND NOT attisdropped`.execute(
        db,
      )
    ).rows.map((r) => r.c);
  const meta = async (name: string) =>
    (
      await sql<{ display_name: string; fields: { name: string }[] }>`
        SELECT display_name, fields FROM zvd_collections WHERE name = ${name}`.execute(db)
    ).rows[0];
  /** Valid indexes on `table` whose name contains `part`; builds may trail the commit. */
  const validIndex = async (table: string, part: string) => {
    for (let i = 0; i < 150; i++) {
      const r = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid
         WHERE x.indrelid = ${`public.${table}`}::regclass AND x.indisvalid
           AND position(${part} in c.relname) > 0`.execute(db);
      if ((r.rows[0]?.n ?? 0) > 0) return true;
      await Bun.sleep(100);
    }
    // CI sometimes never sees the index (Handler Coverage, since 2026-09-30) and
    // no local run reproduces it. Say why before failing: the queue's jobs for
    // this table, and the transactions a CONCURRENTLY build would wait on.
    const jobs = await sql`
      SELECT state, retry_count, created_on, started_on, left(output::text, 200) AS output
        FROM pgboss.job WHERE name = 'build_index' AND data::text LIKE ${`%${table}%`}`
      .execute(db)
      .catch((e) => ({ rows: [{ error: (e as Error).message }] }));
    const old = await sql`
      SELECT pid, state, backend_type, now() - xact_start AS age, wait_event, left(query, 120) AS q
        FROM pg_stat_activity
       WHERE xact_start IS NOT NULL AND pid <> pg_backend_pid() ORDER BY xact_start LIMIT 10`.execute(
      db,
    );
    console.warn(
      `[ext-ddl-mutations] no valid ${part} index on ${table} after 15 s`,
      JSON.stringify({ queue: isDDLQueueStarted(), jobs: jobs.rows, transactions: old.rows }),
    );
    return false;
  };

  beforeAll(async () => {
    db = (await getTestApp()).db;
    _resetExtensionDbRoleForTests();
    await grantExtensionDbRole(db, EXT, new Set());
    const ctx = buildRestrictedContext(
      { db, DDLManager } as unknown as ExtensionContext,
      EXT,
      new Hono(),
      new Set(),
      false,
    );
    ddl = ctx.DDLManager;
    ext = ctx.db as unknown as Database;
  });

  afterAll(async () => {
    // Roles are cluster-wide and outlive this database.
    await revokeExtensionDbRoles(db, EXT, true);
    _resetExtensionDbRoleForTests();
    for (const name of made.reverse()) await dropTestCollection(db, name).catch(() => {});
  });

  for (const mode of MODES) {
    it(`addField, then fills the new column (${mode})`, async () => {
      // No text field yet, so the first one also brings search_text + trigram.
      const name = `ddlmut_add_${mode[0]}${TAG}`;
      await existing(name, [{ name: 'qty', type: 'integer' }]);
      await inRequest(mode, async () => {
        await ddl.addField(ext, name, { name: 'note', type: 'text', indexed: true } as never);
        await sql`INSERT INTO ${sql.id(`zvd_${name}`)} (note) VALUES ('x')`.execute(ext);
      });
      expect(await columns(`zvd_${name}`)).toContain('note');
      expect((await meta(name))!.fields.map((f) => f.name)).toContain('note');
      expect(await validIndex(`zvd_${name}`, '_note')).toBe(true);
      expect(await validIndex(`zvd_${name}`, '_trgm')).toBe(true);
    }, 60_000);

    it(`removeField (${mode})`, async () => {
      const name = `ddlmut_rm_${mode[0]}${TAG}`;
      await existing(name, [
        { name: 'title', type: 'text' },
        { name: 'qty', type: 'integer' },
      ]);
      await inRequest(mode, () => ddl.removeField(ext, name, 'title'));
      expect(await columns(`zvd_${name}`)).not.toContain('title');
      expect((await meta(name))!.fields.map((f) => f.name)).toEqual(['qty']);
    }, 60_000);

    it(`updateCollectionMetadata, search fields changed (${mode})`, async () => {
      const name = `ddlmut_meta_${mode[0]}${TAG}`;
      await existing(name, [
        { name: 'title', type: 'text' },
        { name: 'qty', type: 'integer' },
      ]);
      await inRequest(mode, () =>
        ddl.updateCollectionMetadata(ext, name, {
          displayName: 'Renamed',
          fields: [{ name: 'qty', type: 'integer' }],
        } as never),
      );
      expect((await meta(name))!.display_name).toBe('Renamed');
    }, 60_000);

    it(`registerMetadata + syncFieldsFromDB adopt a table (${mode})`, async () => {
      const name = `ddlmut_adopt_${mode[0]}${TAG}`;
      made.push(name);
      await sql`CREATE TABLE ${sql.id(`zvd_${name}`)} (id uuid PRIMARY KEY, label text)`.execute(
        db,
      );
      let synced = 0;
      await inRequest(mode, async () => {
        const reg = (ddl as unknown as typeof DDLManager).registerMetadata;
        await reg(ext, { name, fields: [] } as never);
        synced = await ddl.syncFieldsFromDB(ext, name);
      });
      expect(synced).toBeGreaterThan(0);
      expect((await meta(name))!.fields.map((f) => f.name)).toContain('label');
    }, 60_000);

    it(`dropCollection (${mode})`, async () => {
      const name = `ddlmut_drop_${mode[0]}${TAG}`;
      await existing(name, [{ name: 'title', type: 'text' }]);
      await inRequest(mode, () => ddl.dropCollection(ext, name));
      const left = await sql<{ t: string | null }>`
        SELECT to_regclass(${`public.zvd_${name}`})::text AS t`.execute(db);
      expect(left.rows[0]!.t).toBeNull();
      expect(await meta(name)).toBeUndefined();
    }, 60_000);

    it(`applyRelationFK + registerRelation, then fills the FK (${mode})`, async () => {
      const parent = `ddlmut_par_${mode[0]}${TAG}`;
      const child = `ddlmut_chi_${mode[0]}${TAG}`;
      await existing(parent, [{ name: 'title', type: 'text' }]);
      await existing(child, [{ name: 'title', type: 'text' }]);
      const raw = ddl as unknown as typeof DDLManager;
      await inRequest(mode, async () => {
        await raw.applyRelationFK(ext, `zvd_${child}`, 'parent', `zvd_${parent}`);
        await raw.registerRelation(ext, {
          name: `${child}_parent`,
          type: 'm2o',
          source_collection: child,
          source_field: 'parent',
          target_collection: parent,
          target_field: 'id',
        });
        await sql`INSERT INTO ${sql.id(`zvd_${child}`)} (parent)
                  SELECT id FROM ${sql.id(`zvd_${parent}`)} LIMIT 1`.execute(ext);
      });
      expect(await columns(`zvd_${child}`)).toContain('parent');
      const rel = await sql<{ n: number }>`SELECT count(*)::int AS n FROM zvd_relations
        WHERE name = ${`${child}_parent`}`.execute(db);
      expect(rel.rows[0]!.n).toBe(1);
      expect(await validIndex(`zvd_${child}`, '_parent')).toBe(true);
    }, 60_000);

    it(`createJunctionTable, fills it, dropJunctionTable (${mode})`, async () => {
      const a = `ddlmut_ja_${mode[0]}${TAG}`;
      const b = `ddlmut_jb_${mode[0]}${TAG}`;
      await existing(a, [{ name: 'title', type: 'text' }]);
      await existing(b, [{ name: 'title', type: 'text' }]);
      const raw = ddl as unknown as typeof DDLManager;
      let junction = '';
      await inRequest(mode, async () => {
        junction = await raw.createJunctionTable(ext, a, b);
        made.push(junction);
        await sql`INSERT INTO ${sql.id(junction)} (${sql.id(`${a}_id`)}, ${sql.id(`${b}_id`)})
                  SELECT (SELECT id FROM ${sql.id(`zvd_${a}`)} LIMIT 1),
                         (SELECT id FROM ${sql.id(`zvd_${b}`)} LIMIT 1)`.execute(ext);
      });
      const forced = await sql<{ f: boolean }>`SELECT relforcerowsecurity AS f FROM pg_class
        WHERE oid = ${`public.${junction}`}::regclass`.execute(db);
      expect(forced.rows[0]!.f).toBe(true);
      // Built with the table, before the request returned — not left running: a
      // concurrent build still in flight waited on the next request below while
      // its DROP waited on the build (55P03, the CI harness lane).
      const built = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid
         WHERE x.indrelid = ${`public.${junction}`}::regclass AND x.indisvalid
           AND (c.relname LIKE '%\_src' OR c.relname LIKE '%\_tgt')`.execute(db);
      expect(built.rows[0]!.n).toBe(2);
      await inRequest(mode, () => raw.dropJunctionTable(ext, junction));
      const left = await sql<{ t: string | null }>`
        SELECT to_regclass(${`public.${junction}`})::text AS t`.execute(db);
      expect(left.rows[0]!.t).toBeNull();
    }, 60_000);
  }
});
