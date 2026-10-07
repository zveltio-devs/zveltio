/**
 * The CONCURRENTLY index builds an extension's `ctx.DDLManager.addField` defers
 * past its request are durable, and a lock it cannot get is a retryable answer.
 *
 * Measured before the fix: the builds lived in an `onAfterCommit` callback, so a
 * request that rolled back after the (already committed) column left it with no
 * index at all; a build over an INVALID index of the same name was a no-op
 * (`IF NOT EXISTS`), so the index stayed unusable; and a 55P03 from the
 * mutation's 2 s lock timeout reached the client as a 500.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  _resetExtensionDbRoleForTests,
  grantExtensionDbRole,
  revokeExtensionDbRoles,
} from '../../lib/extensions/ext-db-role.js';
import { buildExtensionInternals, type ExtensionContext } from '../../lib/extensions/internals.js';
import { buildRestrictedContext } from '../../lib/extensions/register.js';
import { problemOnError } from '../../lib/problem.js';
import { applyTenantRLS } from '../../lib/tenancy/index.js';
import { withTenantIsolation } from '../../lib/tenancy/index.js';
import {
  ALL_COLLECTIONS_ACTOR,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT = '00000000-0000-0000-0000-000000000001';
const EXT = 'ddlidx';
const TAG = Date.now() % 1_000_000;

d('deferred index builds of ctx.DDLManager', () => {
  let db: Database;
  let ddl: ExtensionContext['DDLManager'];
  let ext: Database;
  const made: string[] = [];

  const existing = async (name: string) => {
    made.push(name);
    await DDLManager.createCollection(db, {
      name,
      fields: [{ name: 'qty', type: 'integer' }],
    } as never);
    await applyTenantRLS(db, `zvd_${name}`);
    await sql`INSERT INTO ${sql.id(`zvd_${name}`)} DEFAULT VALUES`.execute(db);
  };
  const inRequest = (fn: () => Promise<void>) =>
    withTenantIsolation(TENANT, fn, { identity: ALL_COLLECTIONS_ACTOR });
  /** The index's definition once it is valid; null if it never becomes valid. */
  const validDef = async (index: string) => {
    for (let i = 0; i < 300; i++) {
      const r = await sql<{ def: string }>`
        SELECT pg_get_indexdef(x.indexrelid) AS def FROM pg_index x
         WHERE x.indexrelid = to_regclass(${`public.${index}`}) AND x.indisvalid`.execute(db);
      if (r.rows[0]) return r.rows[0].def;
      await Bun.sleep(100);
    }
    return null;
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
    for (const name of made.reverse()) await dropTestCollection(db, name).catch(() => {});
    // Roles are cluster-wide: left behind, they outlive this database.
    await revokeExtensionDbRoles(db, EXT, true);
    _resetExtensionDbRoleForTests();
  });

  it('a request that rolls back after addField still gets the index built', async () => {
    const name = `ddlidx_rb${TAG}`;
    await existing(name);
    await inRequest(async () => {
      await ddl.addField(ext, name, { name: 'note', type: 'text', indexed: true } as never);
      // Recorded before the request ends, outside it: a crash from here on loses nothing.
      const queued = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pgboss.job
        WHERE name = 'ddl.build_index' AND singleton_key = ${`idx_zvd_${name}_note`}`.execute(db);
      expect(queued.rows[0]!.n).toBe(1);
      throw new Error('request fails after the schema change');
    }).catch((err: Error) => expect(err.message).toBe('request fails after the schema change'));
    expect(await validDef(`idx_zvd_${name}_note`)).toContain('(note)');
  }, 60_000);

  it('an INVALID index of the same name, left by an interrupted build, is rebuilt', async () => {
    const name = `ddlidx_inv${TAG}`;
    await existing(name);
    const index = `idx_zvd_${name}_note`;
    // What a CONCURRENTLY build killed half-way leaves behind: the name, not valid.
    await sql.raw(`CREATE INDEX ${index} ON zvd_${name} (qty)`).execute(db);
    await sql`UPDATE pg_index SET indisvalid = false
               WHERE indexrelid = to_regclass(${`public.${index}`})`.execute(db);
    await inRequest(() =>
      ddl.addField(ext, name, { name: 'note', type: 'text', indexed: true } as never),
    );
    expect(await validDef(index)).toContain('(note)');
  }, 60_000);

  it('a lock the mutation cannot get answers 503 with Retry-After, not 500', async () => {
    const name = `ddlidx_lock${TAG}`;
    await existing(name);
    const app = new Hono();
    app.onError(problemOnError);
    app.post('/add', async (c) => {
      await inRequest(() => ddl.addField(ext, name, { name: 'late', type: 'integer' } as never));
      return c.json({ ok: true });
    });
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    const holder = db.transaction().execute(async (trx) => {
      await sql.raw(`LOCK TABLE zvd_${name} IN ACCESS SHARE MODE`).execute(trx);
      locked();
      await held;
    });
    await isLocked;
    const res = await app.request('/add', { method: 'POST' });
    release();
    await holder;
    const body = (await res.json()) as { code: string };
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(body.code).toBe('lock_timeout');
  }, 60_000);

  it('a schema change after the request wrote the table answers 409 at once, not a lock wait', async () => {
    const name = `ddlidx_self${TAG}`;
    await existing(name);
    const app = new Hono();
    app.onError(problemOnError);
    app.post('/fill-then-alter', async (c) => {
      await inRequest(async () => {
        await sql`INSERT INTO ${sql.id(`zvd_${name}`)} (qty) VALUES (1)`.execute(ext);
        await ddl.addField(ext, name, { name: 'late', type: 'integer' } as never);
      });
      return c.json({ ok: true });
    });
    const started = Date.now();
    const res = await app.request('/fill-then-alter', { method: 'POST' });
    const body = (await res.json()) as { code: string };
    expect({ status: res.status, code: body.code }).toEqual({
      status: 409,
      code: 'schema_change_after_write',
    });
    // A retry would meet its own lock again: no retry hint, and no 2 s lock_timeout first.
    expect(res.headers.get('retry-after')).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
    const cols = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_attribute
      WHERE attrelid = ${`public.zvd_${name}`}::regclass AND attname = 'late'`.execute(db);
    expect(cols.rows[0]!.n).toBe(0);
  }, 60_000);
});
