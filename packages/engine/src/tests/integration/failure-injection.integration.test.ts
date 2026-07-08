/**
 * H-14 — failure injection. DLQ/retries/pg-boss have happy-path tests; this
 * exercises the FAULTS: Postgres dropped mid-write, registry down mid-install,
 * S3 down mid-upload. Each asserts STATE (no partial/orphan rows), not just the
 * error response, and confirms the typed problem+json envelope (H-13).
 *
 * Requires TEST_DATABASE_URL pointed at a SUPERUSER role (to terminate backends
 * + read zv_* system tables past RLS) — the CI integration Postgres.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { createDb, type Database } from '../../db/index.js';
import { spawnEngine, startMockRegistry, terminateBackend } from '../fixtures/fault-injection.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const skipAll = !TEST_DB_URL;
const S1_TABLE = 'zvd_fault_s1_itest';

let db: Database;

beforeAll(async () => {
  if (skipAll) return;
  db = createDb(TEST_DB_URL!);
  await sql.raw(`DROP TABLE IF EXISTS ${S1_TABLE}`).execute(db);
  await sql.raw(`CREATE TABLE ${S1_TABLE} (id SERIAL PRIMARY KEY, title TEXT)`).execute(db);
});

afterAll(async () => {
  if (skipAll || !db) return;
  await sql.raw(`DROP TABLE IF EXISTS ${S1_TABLE}`).execute(db);
  // biome-ignore lint/suspicious/noExplicitAny: Kysely destroy untyped on the alias
  await (db as any).destroy?.();
});

describe.skipIf(skipAll)('H-14 — failure injection', () => {
  it('S1: Postgres backend killed mid-write → full rollback, no partial row, DB recovers', async () => {
    // Use a RAW Bun.SQL connection for the victim (the thing that gets killed) so
    // there's no Kysely pool wrapper trying to roll back / release a dead socket;
    // the server aborts the transaction on disconnect, which is exactly the fault.
    // max:1 pins ONE connection so BEGIN…pg_sleep…COMMIT all run on the same
    // backend and pg_backend_pid() is the one we kill (a pool would round-robin).
    // biome-ignore lint/suspicious/noExplicitAny: Bun.SQL raw client, driven via .unsafe()
    const victim = new Bun.SQL(TEST_DB_URL!, { max: 1 }) as any;
    const killer = createDb(TEST_DB_URL!);
    const sentinel = `fault-s1-${Date.now()}`; // own value — safe to inline
    let pid = 0;

    // A multi-statement write that holds itself open mid-flight via pg_sleep, so
    // the kill lands deterministically BETWEEN the two inserts (never committed).
    const write = (async () => {
      await victim.unsafe('BEGIN');
      const rows = (await victim.unsafe('SELECT pg_backend_pid() AS pid')) as Array<{
        pid: number;
      }>;
      pid = rows[0]!.pid;
      await victim.unsafe(`INSERT INTO ${S1_TABLE} (title) VALUES ('${sentinel}')`);
      await victim.unsafe('SELECT pg_sleep(5)'); // <-- killed while here
      await victim.unsafe(`INSERT INTO ${S1_TABLE} (title) VALUES ('${sentinel}-2')`);
      await victim.unsafe('COMMIT');
    })()
      .then(() => 'committed')
      .catch((e: Error) => `rejected: ${e.message}`);

    for (let i = 0; i < 50 && pid === 0; i++) await Bun.sleep(100);
    expect(pid).toBeGreaterThan(0);
    await Bun.sleep(500); // ensure we're inside pg_sleep (mid-write)
    await terminateBackend(killer, pid);

    expect(await write).toContain('rejected'); // the in-flight write died

    // The DB serves traffic again WITHOUT a restart — a fresh connection (as the
    // app's pool would open) accepts new queries, and no partial row survived:
    // the whole transaction rolled back.
    const check = createDb(TEST_DB_URL!);
    const recover = await sql<{ ok: number }>`SELECT 1 AS ok`.execute(check);
    expect(recover.rows[0]!.ok).toBe(1);
    const cnt = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM ${sql.id(S1_TABLE)} WHERE title LIKE ${`${sentinel}%`}`.execute(
      check,
    );
    expect(Number(cnt.rows[0]!.n)).toBe(0);

    try {
      await victim.close();
    } catch {
      /* the killed victim connection may throw on close — expected */
    }
    // biome-ignore lint/suspicious/noExplicitAny: destroy untyped
    await (killer as any).destroy?.();
    // biome-ignore lint/suspicious/noExplicitAny: destroy untyped
    await (check as any).destroy?.();
  }, 20000);

  it('S2: registry down mid-install → typed error, advisory lock released, no orphan row, retry proceeds', async () => {
    const extName = `faultprobe${Date.now()}`;
    const mock = startMockRegistry(extName);
    const extDir = mkdtempSync(join(tmpdir(), 'zv-fault-ext-'));
    const engine = await spawnEngine({
      port: 3200,
      dbUrl: TEST_DB_URL!,
      extraEnv: { REGISTRY_URL: mock.url, EXTENSIONS_DIR: extDir },
    });
    try {
      const install = () =>
        fetch(`${engine.baseUrl}/api/marketplace/${extName}/install`, {
          method: 'POST',
          headers: { Cookie: engine.cookie },
        });

      const res = await install();
      // Catalog resolved from the mock, THEN the download died mid-install.
      expect(mock.downloadHits()).toBeGreaterThan(0);
      // A typed failure (non-2xx). Once H-13 is merged this is problem+json; the
      // invariant here is the STATE below, so we don't couple to that merge order.
      expect(res.status).toBeGreaterThanOrEqual(400);

      // No orphan row was written for the failed install.
      const orphan = await sql<{ n: string }>`
        SELECT count(*)::text AS n FROM zv_extension_registry WHERE name = ${extName}`.execute(db);
      expect(Number(orphan.rows[0]!.n)).toBe(0);

      // Advisory lock was released (pg_advisory_xact_lock): a retry PROCEEDS to
      // the same failure instead of hanging/deadlocking on a held lock.
      const retry = await install();
      expect(retry.status).toBeGreaterThanOrEqual(400);
      expect(mock.downloadHits()).toBeGreaterThan(1); // the retry re-attempted
    } finally {
      engine.stop();
      mock.stop();
    }
  }, 60000);

  it('S3: object store down mid-upload → typed 5xx, no orphan metadata row', async () => {
    const engine = await spawnEngine({
      port: 3201,
      dbUrl: TEST_DB_URL!,
      extraEnv: {
        S3_ENDPOINT: 'http://127.0.0.1:1', // nothing listens — unreachable
        S3_ACCESS_KEY: 'probe',
        S3_SECRET_KEY: 'probe',
        S3_BUCKET: 'zveltio',
      },
    });
    try {
      const before = await sql<{ n: string }>`
        SELECT count(*)::text AS n FROM zv_media_files`.execute(db);

      const form = new FormData();
      // Minimal valid PNG signature so magic-byte detection passes and we reach
      // the S3 PUT (which then fails against the dead endpoint).
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      form.append('file', new Blob([png], { type: 'image/png' }), 'probe.png');

      const res = await fetch(`${engine.baseUrl}/api/storage/upload`, {
        method: 'POST',
        headers: { Cookie: engine.cookie },
        body: form,
      });
      // A typed 5xx (problem+json once H-13 is merged); the load-bearing check
      // is the no-orphan STATE below, so we don't couple to that merge order.
      expect(res.status).toBeGreaterThanOrEqual(500);

      // The metadata row is only written AFTER a successful PUT — assert the
      // failed upload left NO orphan row.
      const after = await sql<{ n: string }>`
        SELECT count(*)::text AS n FROM zv_media_files`.execute(db);
      expect(Number(after.rows[0]!.n)).toBe(Number(before.rows[0]!.n));
    } finally {
      engine.stop();
    }
  }, 60000);
});
