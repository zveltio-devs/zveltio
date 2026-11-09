/**
 * A job's `host.files` (ADR 0031), end to end in the Deno runner on the
 * engine's queue, database and storage driver: the job acts as its author
 * through `/api/storage`'s own checks — it stores a private file of the
 * author's in its tenant, reads what the author may read and nothing else,
 * deletes only the author's own, is held to the author's quota and to the
 * per-call and per-run byte limits, and has no files without `files` or
 * without an author. A file of mail size (20 MiB) crosses the channel both
 * ways, past the 16 MiB stdout ceiling the bytes no longer count against.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { ManifestSchema } from '../../lib/extensions/manifest-schema.js';
import {
  compileJobs,
  JOB_FILE_LIMITS,
  storageActionsOf,
  jobQueueName,
  registerJobs,
  unregisterJobs,
  verifiedJobsCode,
} from '../../lib/extensions/jobs.js';
import { ensureDeno } from '../../lib/extensions/deno.js';
import { DDLManager, jobQueue } from '../../lib/data/index.js';
import { getStorage } from '../../lib/storage/index.js';
import { type FileActor, storeFile } from '../../lib/stored-files.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/index.js';
import {
  asEveryTenant,
  asTenant,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const C = `jobfiles_${STAMP}`;
const EXT = `jobfiles-ext-${STAMP}`;
/** The same code, without `files` approved. */
const BARE = `jobfiles-bare-${STAMP}`;
const TENANT = crypto.randomUUID();
const SLUG = `jobfiles-${TENANT.slice(0, 8)}`;
const AUTHOR = `jobfiles-author-${STAMP}`;
const COLLEAGUE = `jobfiles-colleague-${STAMP}`;

const JOBS_JS = `
const record = (host, label) => host.collections.insert(${JSON.stringify(C)}, { label });
const fail = (e) => 'E' + (e.status ?? '') + ':' + e.message;
export default {
  roundtrip: async (input, host) => {
    const bytes = new Uint8Array(input.size);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const f = await host.files.put(input.name, bytes);
    const back = await host.files.get(f.id);
    let same = back.bytes.length === bytes.length;
    for (let i = 0; same && i < bytes.length; i += 4093) same = back.bytes[i] === bytes[i];
    await record(host, ['rt', input.tag, f.id, back.contentType, back.size, same].join('|'));
  },
  probe: async (input, host) => {
    const out = [];
    for (const id of input.get ?? []) {
      try {
        out.push((await host.files.get(id)) ? 'read' : 'null');
      } catch (e) {
        out.push(fail(e));
      }
    }
    for (const id of input.del ?? []) {
      try {
        await host.files.delete(id);
        out.push('deleted');
      } catch (e) {
        out.push(fail(e));
      }
    }
    for (const size of input.put ?? []) {
      try {
        out.push('put:' + (await host.files.put('p.txt', new Uint8Array(size))).size);
      } catch (e) {
        out.push(fail(e));
      }
    }
    await record(host, ['probe', input.tag, ...out].join('|'));
  },
  // Writes, then fails: the run's one transaction rolls back.
  delthrow: async (input, host) => {
    await host.files.delete(input.id);
    throw new Error('after the delete');
  },
  putthrow: async (input, host) => {
    await host.files.put('undone.txt', new Uint8Array(64));
    throw new Error('after the put');
  },
};
`;

d('a job reaches stored files as its author (ADR 0031)', () => {
  let db: Database;
  let extDir = '';
  /** Files made before the jobs run, through the route's own path. */
  const made: Record<string, string> = {};

  const labels = async (prefix: string) =>
    asEveryTenant(
      db,
      async (trx) =>
        (
          await sql<{ label: string }>`
            SELECT label FROM ${sql.table(`zvd_${C}`)} WHERE label LIKE ${`${prefix}%`}`.execute(
            trx,
          )
        ).rows,
    ).then((r) => r.map((x) => x.label));
  const send = (
    ext: string,
    job: string,
    input: object,
    author: string | null = AUTHOR,
    payload: Record<string, unknown> = {},
  ) =>
    jobQueue()!.send(
      jobQueueName(ext, job),
      { tenantId: TENANT, enqueuedBy: author ?? 'test', author, input, ...payload },
      { retryLimit: 0, retryDelay: 1, expireInSeconds: 180 },
    ) as Promise<string>;
  /** Run `job`, which records nothing, and wait for it to fail. */
  const failed = async (job: string, input: object) => {
    const id = await send(EXT, job, input);
    return until(
      async () =>
        (
          await sql<{ state: string }>`SELECT state FROM pgboss.job WHERE id = ${id}::uuid`.execute(
            db,
          )
        ).rows[0]?.state,
      (st) => st === 'failed' || st === 'completed',
    );
  };
  async function until<T>(probe: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
    for (let i = 0; i < 300; i++) {
      const v = await probe();
      if (done(v)) return v;
      await Bun.sleep(100);
    }
    return probe();
  }
  /** Run `job` and answer the one label it recorded under `tag`. */
  const result = async (
    job: string,
    input: { tag: string } & Record<string, unknown>,
    ext = EXT,
    author: string | null = AUTHOR,
    payload: Record<string, unknown> = {},
  ) => {
    await send(ext, job, input, author, payload);
    const prefix = `${job === 'roundtrip' ? 'rt' : 'probe'}|${input.tag}|`;
    const got = await until(
      () => labels(prefix),
      (r) => r.length > 0,
    );
    return got[0]?.slice(prefix.length) ?? '(no result)';
  };
  const actor = (tenantId: string, user: string): FileActor => ({
    tenantId,
    principalId: user,
    author: user,
    apiKeyRow: null,
    seesAll: false,
  });
  const make = async (tenantId: string, user: string, isPublic = false) => {
    const r = await asTenant(db, tenantId, (trx) =>
      storeFile(trx, actor(tenantId, user), {
        name: 'made.txt',
        bytes: new TextEncoder().encode('made'),
        isPublic,
      }),
    );
    if (!('file' in r)) throw new Error(`fixture refused: ${r.body.error}`);
    return r.file.id;
  };
  const row = (id: string) =>
    asEveryTenant(db, (trx) =>
      trx.selectFrom('zv_media_files').selectAll().where('id', '=', id).executeTakeFirst(),
    );

  beforeAll(async () => {
    await ensureDeno();
    ({ db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: C,
      fields: [{ name: 'label', type: 'text', required: false, unique: false, indexed: false }],
    });
    for (let i = 0; i < 100; i++) {
      const seen = await sql<{ a: string | null }>`SELECT to_regclass(${`zvd_${C}`}) AS a`.execute(
        db,
      );
      if (seen.rows[0]?.a) break;
      await Bun.sleep(100);
    }
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${TENANT}::uuid, ${SLUG}, ${SLUG}, 'active')`.execute(db);
    for (const id of [AUTHOR, COLLEAGUE]) {
      await sql`INSERT INTO "user" (id, name, email)
                VALUES (${id}, ${id}, ${`${id}@test.local`})`.execute(db);
    }
    made.colleaguePrivate = await make(TENANT, COLLEAGUE);
    made.colleagueShared = await make(TENANT, COLLEAGUE, true);
    made.ownPrivate = await make(TENANT, AUTHOR);
    made.ownOtherTenant = await make(DEFAULT_TENANT_ID, AUTHOR);

    extDir = mkdtempSync(join(tmpdir(), 'zv-jobfiles-ext-'));
    mkdirSync(join(extDir, 'engine'));
    writeFileSync(join(extDir, 'engine', 'jobs.js'), JOBS_JS);
    const manifest = (name: string) =>
      ManifestSchema.parse({
        name,
        engine: { entry: 'engine/index.js', bundled: true, isolation: 'worker' },
        integrity: { jobsSha256: createHash('sha256').update(JOBS_JS).digest('hex') },
        jobs: ['roundtrip', 'probe', 'delthrow', 'putthrow'].map((job) => ({
          name: job,
          input: { type: 'object' },
          reads: [],
          writes: [C],
          timeoutSeconds: 60,
          memoryMb: 512,
        })),
      });
    for (const [name, granted] of [
      [EXT, ['data:system', 'files']],
      [BARE, ['data:system']],
    ] as const) {
      const m = manifest(name);
      registerJobs(
        name,
        compileJobs(name, m, { name } as ZveltioExtension, true, verifiedJobsCode(extDir, m)),
        granted,
      );
    }
    await until(
      async () =>
        Number(
          (
            await sql<{ n: string }>`SELECT count(*) AS n FROM pgboss.queue
              WHERE name LIKE ${`ext.${EXT}.%`} OR name LIKE ${`ext.${BARE}.%`}`.execute(db)
          ).rows[0]?.n,
        ),
      (n) => n === 8,
    );
  }, 180_000);

  afterAll(async () => {
    await unregisterJobs(EXT);
    await unregisterJobs(BARE);
    if (extDir) rmSync(extDir, { recursive: true, force: true });
    if (!db) return;
    const files = await asEveryTenant(db, (trx) =>
      trx
        .selectFrom('zv_media_files')
        .select(['id', 'storage_path'])
        .where('created_by', 'in', [AUTHOR, COLLEAGUE])
        .execute(),
    );
    for (const f of files)
      await getStorage()
        .delete(f.storage_path)
        .catch(() => undefined);
    await asEveryTenant(db, (trx) =>
      trx.deleteFrom('zv_media_files').where('created_by', 'in', [AUTHOR, COLLEAGUE]).execute(),
    );
    await sql`DELETE FROM pgboss.job WHERE name LIKE ${`ext.${EXT}.%`} OR name LIKE ${`ext.${BARE}.%`}`.execute(
      db,
    );
    await asEveryTenant(db, (trx) =>
      sql`DELETE FROM zv_audit_log WHERE event_type = 'extension.job.executed'
          AND metadata->>'extension' IN (${EXT}, ${BARE})`.execute(trx),
    );
    await asEveryTenant(db, (trx) =>
      sql`DELETE FROM zv_revisions WHERE collection = ${C}`.execute(trx),
    );
    await dropTestCollection(db, C);
    await sql`DELETE FROM zv_tenants WHERE id = ${TENANT}::uuid`.execute(db);
    await sql`DELETE FROM "user" WHERE id IN (${AUTHOR}, ${COLLEAGUE})`.execute(db);
  });

  it('stores a private file of its author, in its tenant, and reads it back', async () => {
    const [id, type, size, same] = (
      await result('roundtrip', { tag: 'small', name: 'note.txt', size: 1000 })
    ).split('|');
    expect([type, size, same]).toEqual(['text/plain', '1000', 'true']);
    const r = await row(id!);
    expect(r).toMatchObject({
      tenant_id: TENANT,
      created_by: AUTHOR,
      created_by_api_key: null,
      visibility: 'personal',
      original_name: 'note.txt',
    });
    // The bytes are in the store, where Studio's `/api/storage/:id` serves them from.
    expect((await getStorage().get(r!.storage_path))?.bytes.byteLength).toBe(1000);
  }, 60_000);

  it('moves a file of mail size both ways, past the 16 MiB channel', async () => {
    const out = await result('roundtrip', {
      tag: 'big',
      name: 'big.pdf',
      size: 20 * 1024 * 1024,
    });
    expect(out.split('|').slice(2)).toEqual([String(20 * 1024 * 1024), 'true']);
  }, 120_000);

  it("reads what its author may read, and not a colleague's or another tenant's", async () => {
    const out = await result('probe', {
      tag: 'reads',
      get: [made.ownPrivate, made.colleagueShared, made.colleaguePrivate, made.ownOtherTenant],
    });
    expect(out).toBe('read|read|null|null');
  }, 60_000);

  it("deletes its author's file, and not a colleague's", async () => {
    const out = await result('probe', {
      tag: 'deletes',
      del: [made.colleagueShared, made.ownPrivate, made.ownOtherTenant, made.colleaguePrivate],
    });
    // A file it cannot read is not found, as `get` answers: 403 would say it exists.
    expect(out).toBe(
      'E403:host.files.delete: Forbidden|deleted|E404:host.files.delete: File not found|' +
        'E404:host.files.delete: File not found',
    );
    expect(await row(made.colleaguePrivate!)).toBeDefined();
    expect(await row(made.colleagueShared!)).toBeDefined();
    expect(await row(made.ownPrivate!)).toBeUndefined();
    expect(await row(made.ownOtherTenant!)).toBeDefined();
  }, 60_000);

  it('keeps the bytes of a file whose delete a failing run rolls back', async () => {
    const id = await make(TENANT, AUTHOR);
    const path = (await row(id))!.storage_path;
    expect(await failed('delthrow', { id })).toBe('failed');
    expect(await row(id)).toBeDefined();
    expect(await getStorage().get(path)).not.toBeNull();
  }, 60_000);

  it('removes the bytes of a file whose put a failing run rolls back', async () => {
    const driver = getStorage();
    const put = driver.put.bind(driver);
    const stored: string[] = [];
    driver.put = async (key, bytes, opts) => {
      stored.push(key);
      return put(key, bytes, opts);
    };
    try {
      expect(await failed('putthrow', {})).toBe('failed');
    } finally {
      driver.put = put;
    }
    expect(stored).toHaveLength(1);
    expect(await driver.get(stored[0]!)).toBeNull();
  }, 60_000);

  it('never exceeds the $storage scope of the key that enqueued it', async () => {
    expect(storageActionsOf({ id: AUTHOR } as never)).toEqual(['read', 'create', 'delete']);
    expect(
      storageActionsOf({
        id: `apikey:${crypto.randomUUID()}`,
        scopes: [{ collection: '$storage', actions: ['read'] }],
      } as never),
    ).toEqual(['read']);
    const key = { enqueuedBy: `apikey:${crypto.randomUUID()}` };
    const out = await result(
      'probe',
      { tag: 'readkey', get: [made.colleagueShared], put: [10], del: [made.colleagueShared] },
      EXT,
      AUTHOR,
      { ...key, storage: ['read'] },
    );
    expect(out).toBe(
      'read|E403:host.files.delete: the API key that enqueued this job lacks $storage for delete|' +
        'E403:host.files.put: the API key that enqueued this job lacks $storage for create',
    );
    // Queued before the scope was recorded: a key's job gets none.
    const legacy = await result(
      'probe',
      { tag: 'oldkey', get: [made.colleagueShared] },
      EXT,
      AUTHOR,
      key,
    );
    expect(legacy).toBe(
      'E403:host.files.get: the API key that enqueued this job lacks $storage for read',
    );
  }, 60_000);

  it("is held to its author's quota", async () => {
    // In the job's tenant: where `storage/cloud` has added a tenant column, its default is that.
    await asTenant(db, TENANT, (trx) =>
      sql`INSERT INTO zv_storage_quotas (user_id, quota_bytes, used_bytes)
          VALUES (${AUTHOR}, 1, 0)`.execute(trx),
    );
    try {
      const out = await result('probe', { tag: 'quota', put: [10] });
      expect(out).toBe('E413:host.files.put: Storage quota exceeded');
    } finally {
      await asEveryTenant(db, (trx) =>
        sql`DELETE FROM zv_storage_quotas WHERE user_id = ${AUTHOR}`.execute(trx),
      );
    }
  }, 60_000);

  it('is held to the per-call and per-run byte limits', async () => {
    const saved = { ...JOB_FILE_LIMITS };
    JOB_FILE_LIMITS.callBytes = 1000;
    JOB_FILE_LIMITS.runBytes = 1500;
    try {
      const out = await result('probe', { tag: 'limits', put: [1001, 1000, 600] });
      expect(out).toBe(
        'E413:host.files.put: 1001 bytes; a call moves at most 1000|put:1000|' +
          'E413:host.files.put: a run moves at most 1500 bytes',
      );
    } finally {
      Object.assign(JOB_FILE_LIMITS, saved);
    }
  }, 60_000);

  it('has no files without the files capability', async () => {
    const out = await result('probe', { tag: 'bare', get: [made.colleagueShared] }, BARE);
    expect(out).toBe(
      `E403:host.files.get: "${BARE}" does not hold the "files" capability ` +
        '(declared in its manifest and approved by an administrator)',
    );
  }, 60_000);

  it('has no files without an author', async () => {
    const out = await result(
      'probe',
      { tag: 'authorless', get: [made.colleagueShared] },
      EXT,
      null,
    );
    expect(out).toBe(
      'E403:host.files.get: a job enqueued without a user (a public route) has no files',
    );
  }, 60_000);
});
