/**
 * A key is its author to a row rule (ADR 0028).
 *
 * Broken: a row rule's `user_id` and `user_email` resolved to the key principal
 * itself — `apikey:<uuid>`, `apikey:job:<ext>:<job>`, email `''` — in the engine
 * (`getRlsFilters`) and in the database policy (`zv_row_rules`, which read
 * `zveltio.user_id`). The rows a key writes are authored by its author
 * (`rowAuthorId`), so `* created_by eq user_id` hid a member's own rows from
 * their own API key, and the rows a user asked an extension job to work on from
 * that job.
 *
 * Fixed: both resolve to the author — a member key's issuer, a job's enqueuing
 * user, `''` (no row) without one. The database reads it from its own setting,
 * `zveltio.row_user_id` / `zveltio.row_user_email`; `zveltio.user_id` stays the
 * key, which the engine's own table policies read as the caller.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { authenticate } from '../../lib/data/auth.js';
import { DDLManager, jobQueue } from '../../lib/data/index.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals, type ExtensionContext } from '../../lib/extensions/internals.js';
import { jobQueueName, unregisterJobs } from '../../lib/extensions/jobs.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import { ManifestSchema } from '../../lib/extensions/manifest-schema.js';
import { finalizeExtensionLoad } from '../../lib/extensions/register.js';
import { toJsonb } from '../../lib/jsonb.js';
import { DEFAULT_TENANT_ID } from '../../lib/route-db.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import {
  createRequestScopedDb,
  invalidateRlsCache,
  withTenantIsolation,
} from '../../lib/tenancy/index.js';
import { getEnforcer, invalidateUserPermCache } from '../../lib/tenancy/permissions.js';
import {
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const C = `hkeyauthor_${STAMP}`;
const TABLE = `zvd_${C}`;
const EXT = `key-author-${STAMP}`;
const ROLE = `keyauthor_${STAMP}`;

/** What one job run saw and could change. */
interface Seen {
  titles: string[];
  ownUpdate: number | undefined;
  otherUpdate: number | undefined;
}

d('a key is its author to a row rule (ADR 0028)', () => {
  let engine: Hono;
  let db: Database;
  let a: { cookie: string; userId: string; email: string };
  let b: { cookie: string; userId: string; email: string };
  let keyId = '';
  let raw = '';
  const rowId: Record<string, string> = {};
  const seen = new Map<string, Seen>();

  const rule = (field: string, source: string) =>
    sql`INSERT INTO zvd_rls_policies
          (collection, role, filter_field, filter_op, filter_value_source, is_enabled)
        VALUES (${C}, '*', ${field}, 'eq', ${source}, true)`.execute(db);
  /** Replace the collection's rules, through the route's own refresh. */
  const onlyRule = async (field: string, source: string) => {
    await sql`DELETE FROM zvd_rls_policies WHERE collection = ${C}`.execute(db);
    await rule(field, source);
    await invalidateRlsCache(C);
  };

  /** Titles the data API serves the key. */
  const keyReads = async () => {
    const res = await engine.request(`/api/data/${C}?limit=50`, { headers: { 'X-API-Key': raw } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: Array<{ title: string }> };
    return body.records.map((r) => r.title).sort();
  };
  const keyUpdates = async (title: string) =>
    (
      await engine.request(`/api/data/${C}/${rowId[title]}`, {
        method: 'PATCH',
        headers: { 'X-API-Key': raw, 'content-type': 'application/json' },
        body: JSON.stringify({ note: `by key ${STAMP}` }),
      })
    ).status;
  const sessionReads = async (cookie: string) => {
    const res = await engine.request(`/api/data/${C}?limit=50`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: Array<{ title: string }> };
    return body.records.map((r) => r.title).sort();
  };

  /** What a raw statement under the key's published identity reads: the database alone. */
  const asKeyInDatabase = <T>(fn: (trx: Database) => Promise<T>) =>
    withTenantIsolation(
      DEFAULT_TENANT_ID,
      async (trx) => {
        const ctx = {
          get: (k: string) => (k === 'prefetchedSession' ? null : undefined),
          req: {
            header: (h: string) => (h === 'X-API-Key' ? raw : undefined),
            raw: { headers: new Headers() },
          },
        };
        const who = await authenticate(ctx as never, {} as never, db);
        expect(who?.user.id).toBe(`apikey:${keyId}`);
        return fn(trx);
      },
      { userId: null },
    );
  const keyReadsInDatabase = () =>
    asKeyInDatabase(async (trx) =>
      (
        await sql<{ title: string }>`SELECT title FROM ${sql.table(TABLE)} ORDER BY title`.execute(
          trx,
        )
      ).rows.map((r) => r.title),
    );

  /** Run the `scan` job as enqueued by `author`, and wait for what it saw. */
  const runJob = async (author: string | null, viaSql = false): Promise<Seen> => {
    const label = crypto.randomUUID();
    await jobQueue()!.send(
      jobQueueName(EXT, 'scan'),
      {
        tenantId: DEFAULT_TENANT_ID,
        enqueuedBy: author ?? `ext:${EXT}:route`,
        author,
        input: { label, viaSql },
      },
      { retryLimit: 0 },
    );
    for (let i = 0; i < 150 && !seen.has(label); i++) await Bun.sleep(100);
    const out = seen.get(label);
    if (!out) throw new Error('the job did not run');
    return out;
  };

  beforeAll(async () => {
    ({ app: engine, db } = await getTestApp());
    _setInlineForTests(true);
    await DDLManager.createCollection(db, {
      name: C,
      adoptRules: true,
      fields: ['title', 'owner_email', 'note', 'status'].map((name) => ({
        name,
        type: 'text',
        required: false,
        unique: false,
        indexed: false,
      })),
    } as never);
    const grants = [{ collection: C, actions: ['read', 'update'] }];
    a = await createMemberSession(engine, db, { grants });
    b = await createMemberSession(engine, db, { grants });
    for (const [title, owner, status] of [
      ['a1', a, 'published'],
      ['a2', a, 'draft'],
      ['b1', b, 'published'],
    ] as const) {
      const r = await sql<{ id: string }>`
        INSERT INTO ${sql.table(TABLE)} (tenant_id, title, owner_email, created_by, status)
        VALUES (${DEFAULT_TENANT_ID}::uuid, ${title}, ${owner.email}, ${owner.userId}, ${status})
        RETURNING id`.execute(db);
      rowId[title] = String(r.rows[0]!.id);
    }
    await onlyRule('created_by', 'user_id');

    raw = generateApiKey();
    keyId = (
      await sql<{ id: string }>`
        INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, rate_limit, is_active, tenant_id, created_by)
        VALUES ('key author probe', ${await hashApiKey(raw)}, 'zvk_', ${JSON.stringify(grants)}::jsonb, 1000, true,
                ${DEFAULT_TENANT_ID}::uuid, ${a.userId})
        RETURNING id`.execute(db)
    ).rows[0]!.id;

    // An extension job reading and updating the collection, recording what it saw.
    const ext: ZveltioExtension = {
      name: EXT,
      category: 'custom',
      mountStrategy: 'subapp',
      jobs: {
        scan: async (input, host) => {
          const { label, viaSql } = input as { label: string; viaSql?: boolean };
          // `viaSql`: a raw statement on the job's transaction — the database policy alone.
          const list = viaSql
            ? {
                records: (
                  await sql<{ title: string }>`SELECT title FROM ${sql.table(TABLE)}`.execute(
                    createRequestScopedDb(db),
                  )
                ).rows,
              }
            : ((await host.collections.list(C, { limit: 50 })) as {
                records: Array<{ title: string }>;
              });
          const status = (title: string) =>
            host.collections.update(C, rowId[title]!, { note: `by job ${label}` }).then(
              () => 200,
              (e: { status?: number }) => e.status ?? 500,
            );
          seen.set(label, {
            titles: list.records.map((r) => r.title).sort(),
            ownUpdate: await status('a1'),
            otherUpdate: await status('b1'),
          });
        },
      },
      async register() {},
    } as ZveltioExtension;
    const manifest = ManifestSchema.parse({
      name: EXT,
      permissions: ['data:system'],
      jobs: [
        {
          name: 'scan',
          input: {
            type: 'object',
            properties: { label: { type: 'string' }, viaSql: { type: 'boolean' } },
          },
          reads: [C],
          writes: [C],
          retry: { limit: 0 },
        },
      ],
    });
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT}`.execute(db);
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled, manifest)
      VALUES (${EXT}, ${EXT}, NULL, true, true, ${toJsonb(manifest)})`.execute(db);
    const ctx = { db, internals: buildExtensionInternals() } as unknown as ExtensionContext;
    const loader = {
      loaded: new Map(),
      modules: new Map(),
      lastLoadError: new Map(),
      extDirs: new Map(),
      forgetExtensionMessages: () => {},
      ctx,
    } as unknown as ExtensionLoader;
    await finalizeExtensionLoad(
      loader,
      ext,
      EXT,
      `/tmp/${EXT}`,
      new Hono(),
      ctx,
      manifest as never,
      new Set(),
    );
  }, 60_000);

  afterAll(async () => {
    await unregisterJobs(EXT);
    if (!db) return;
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT}`.execute(db).catch(() => {});
    await sql`DELETE FROM zv_api_keys WHERE id = ${keyId}::uuid`.execute(db).catch(() => {});
    await sql`DELETE FROM zvd_rls_policies WHERE collection = ${C}`.execute(db).catch(() => {});
    await dropTestCollection(db, C).catch(() => {});
  });

  it("(a) a member key reads and updates its issuer's rows, and no one else's", async () => {
    expect(await keyReads()).toEqual(['a1', 'a2']);
    expect(await keyReadsInDatabase()).toEqual(['a1', 'a2']);
    expect(await keyUpdates('a1')).toBe(200);
    expect(await keyUpdates('b1')).toBe(404);
  });

  it("(b) a job enqueued by A reads and updates A's rows, not B's", async () => {
    expect(await runJob(a.userId)).toEqual({
      titles: ['a1', 'a2'],
      ownUpdate: 200,
      otherUpdate: 404,
    });
    expect((await runJob(b.userId)).titles).toEqual(['b1']);
  });

  it('(c) a job with no author sees no row the rule covers', async () => {
    expect(await runJob(null)).toEqual({ titles: [], ownUpdate: 404, otherUpdate: 404 });
  });

  it('(d) a session is unchanged: its own rows', async () => {
    expect(await sessionReads(a.cookie)).toEqual(['a1', 'a2']);
    expect(await sessionReads(b.cookie)).toEqual(['b1']);
  });

  it('(e) a `user_email` rule resolves to the author the same way', async () => {
    await onlyRule('owner_email', 'user_email');
    try {
      expect(await keyReads()).toEqual(['a1', 'a2']);
      expect(await keyReadsInDatabase()).toEqual(['a1', 'a2']);
      expect((await runJob(a.userId)).titles).toEqual(['a1', 'a2']);
      expect((await runJob(null)).titles).toEqual([]);
      expect(await sessionReads(b.cookie)).toEqual(['b1']);
    } finally {
      await onlyRule('created_by', 'user_id');
    }
  });

  it("(g) a job never exceeds its author: the author's own role rules bind it too", async () => {
    // A role only A holds, whose rule hides drafts from A. The job's own roles
    // are `api_key`; without its author's half it read A's draft.
    const e = await getEnforcer();
    await e.addRoleForUser(a.userId, ROLE, '*');
    await invalidateUserPermCache(a.userId);
    await sql`INSERT INTO zvd_rls_policies
                (collection, role, filter_field, filter_op, filter_value_source, is_enabled)
              VALUES (${C}, ${ROLE}, 'status', 'eq', 'static:published', true)`.execute(db);
    await invalidateRlsCache(C);
    try {
      expect(await sessionReads(a.cookie)).toEqual(['a1']);
      expect(await keyReads()).toEqual(['a1']);
      expect(await keyReadsInDatabase()).toEqual(['a1']);
      expect((await runJob(a.userId)).titles).toEqual(['a1']);
      // In the database too: a raw read on the job's own transaction.
      expect((await runJob(a.userId, true)).titles).toEqual(['a1']);
      // B does not hold the role: B's job is not bound by it.
      expect((await runJob(b.userId)).titles).toEqual(['b1']);
      // An authorless job still runs, bounded by its manifest; it owns no row.
      expect(await runJob(null)).toEqual({ titles: [], ownUpdate: 404, otherUpdate: 404 });
    } finally {
      await onlyRule('created_by', 'user_id');
      await e.deleteRoleForUser(a.userId, ROLE, '*');
      await invalidateUserPermCache(a.userId);
    }
  });

  it('(f) the caller the engine sees stays the key: engine tables are not opened to it', async () => {
    const settings = await asKeyInDatabase(
      async (trx) =>
        (
          await sql<{ uid: string; row_uid: string; row_email: string }>`
            SELECT current_setting('zveltio.user_id', true) AS uid,
                   current_setting('zveltio.row_user_id', true) AS row_uid,
                   current_setting('zveltio.row_user_email', true) AS row_email`.execute(trx)
        ).rows[0]!,
    );
    expect(settings).toEqual({ uid: `apikey:${keyId}`, row_uid: a.userId, row_email: a.email });
    // A's sessions stay out of the key's reach, as before: refused outright.
    const sessions = await asKeyInDatabase((trx) =>
      sql`SAVEPOINT probe`
        .execute(trx)
        .then(() =>
          sql<{
            n: string;
          }>`SELECT count(*)::text AS n FROM "session" WHERE "userId" = ${a.userId}`.execute(trx),
        )
        .then(
          (r) => r.rows[0]!.n,
          async (e: { errno?: string }) => {
            await sql`ROLLBACK TO SAVEPOINT probe`.execute(trx);
            return e.errno;
          },
        ),
    );
    expect(String(sessions)).toBe('42501');
  });
});
