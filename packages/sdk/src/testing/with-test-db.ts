/**
 * Postgres-backed integration test helper (S4-06 follow-up).
 *
 * `withTestDb(fn)` spins up a real Postgres container via `testcontainers`,
 * yields a Kysely instance connected to it, runs the user's callback, then
 * tears the container down. Use this when `mockDb` is insufficient — e.g.
 * when an extension hook chains a real SELECT through `ctx.db`, or when you
 * want to verify migrations apply cleanly.
 *
 * Requires:
 *   - Docker / Podman running on the test host.
 *   - `testcontainers` installed (peer dep — declare as devDep in the
 *     extension's package.json). We import it dynamically so unit-test
 *     workflows that never call `withTestDb` don't take the heavy hit.
 *
 * Cost model:
 *   - First call: ~3-5s (image pull + container start). Subsequent calls
 *     reuse the cached image, ~1-2s. Use one container across a `describe()`
 *     block when you can — the wrapper supports nesting via `reuse`.
 *
 * Why a peer dep + dynamic import:
 *   - `testcontainers` pulls `dockerode` + a bunch of Node-ish modules. We
 *     don't want every consumer of `@zveltio/sdk/testing` to inherit that
 *     weight just to use `mockDb`. By importing lazily, the cost is
 *     opt-in at the call site.
 */

import type { Kysely } from 'kysely';

export interface WithTestDbOptions {
  /** Postgres image. Default: `postgres:18-alpine`. */
  image?: string;
  /** DB name to create. Default: `zveltio_test`. */
  database?: string;
  /** Optional SQL strings to run after the container is ready. */
  migrations?: string[];
  /**
   * Container start timeout, ms. Default: 60_000. Cold pulls can be slow
   * on the first run; CI environments may want 120_000.
   */
  startupTimeoutMs?: number;
  /**
   * If passed, the container is started once and reused. Pass `false`
   * (default) to start + stop per call.
   */
  reuse?: boolean;
}

export interface TestDb {
  /** Kysely instance — same shape as `ctx.db` in production. */
  db: Kysely<any>;
  /** Connection string the container exposed. */
  connectionString: string;
  /** Stop + remove the container (also closes the Kysely pool). */
  cleanup(): Promise<void>;
}

// ── Module-level reuse cache ────────────────────────────────────────────────
//
// When `reuse: true`, we keep a single container alive for the process
// lifetime. The first call to `withTestDb` boots it; subsequent calls open
// fresh DBs *inside* the same container (CREATE DATABASE per-call), so
// tests stay isolated without paying the container-start cost again.

let _sharedContainer: any | null = null;
let _sharedClient: any | null = null;
let _sharedDbCounter = 0;

async function loadPgContainer(): Promise<typeof import('@testcontainers/postgresql')> {
  try {
    return await import('@testcontainers/postgresql');
  } catch {
    throw new Error(
      `withTestDb requires the '@testcontainers/postgresql' npm package. ` +
        `Install it as a devDep in your extension:\n` +
        `  bun add -d @testcontainers/postgresql pg @types/pg`,
    );
  }
}

async function loadKysely(): Promise<typeof import('kysely')> {
  return await import('kysely');
}

/**
 * Spin up Postgres, optionally run migrations, return a `TestDb` handle.
 * The caller is responsible for calling `cleanup()` (typically inside an
 * `afterAll`/`afterEach`).
 *
 * For the more common "scope the lifecycle to a test/describe block"
 * pattern, prefer `withTestDb(fn)` below.
 */
export async function startTestDb(opts: WithTestDbOptions = {}): Promise<TestDb> {
  const image = opts.image ?? 'postgres:18-alpine';
  const database =
    opts.database ?? `zveltio_test_${Date.now()}_${Math.floor(Math.random() * 10_000)}`;
  const startupTimeoutMs = opts.startupTimeoutMs ?? 60_000;

  const tc = await loadPgContainer();
  const { Kysely, PostgresDialect } = await loadKysely();

  let host: string;
  let port: number;
  let username: string;
  let password: string;
  let createdContainer: any = null;

  if (opts.reuse && _sharedContainer) {
    host = _sharedContainer.getHost();
    port = _sharedContainer.getMappedPort(5432);
    username = _sharedContainer.getUsername();
    password = _sharedContainer.getPassword();
  } else {
    const builder = new tc.PostgreSqlContainer(image).withStartupTimeout(startupTimeoutMs);
    createdContainer = await builder.start();
    if (opts.reuse) _sharedContainer = createdContainer;

    host = createdContainer.getHost();
    port = createdContainer.getMappedPort(5432);
    username = createdContainer.getUsername();
    password = createdContainer.getPassword();
  }

  // testcontainers' default db is `test`. Create our own so multiple
  // reuse=true calls don't share state.
  const adminConnStr = `postgres://${username}:${password}@${host}:${port}/postgres`;
  const adminPool = await openPgPool(adminConnStr);
  try {
    await adminPool.query(`CREATE DATABASE "${database}"`);
    _sharedDbCounter++;
  } finally {
    await adminPool.end();
  }

  const connectionString = `postgres://${username}:${password}@${host}:${port}/${database}`;
  const pool = await openPgPool(connectionString);

  const db = new Kysely<any>({
    dialect: new PostgresDialect({ pool: pool as any }),
  });

  if (opts.migrations && opts.migrations.length > 0) {
    await applyMigrationStrings(db, opts.migrations);
  }

  return {
    db,
    connectionString,
    async cleanup(): Promise<void> {
      try {
        await db.destroy();
      } catch {
        /* */
      }
      try {
        await pool.end();
      } catch {
        /* */
      }
      if (createdContainer && !opts.reuse) {
        try {
          await createdContainer.stop();
        } catch {
          /* */
        }
      }
    },
  };
}

/**
 * Convenience wrapper: starts a TestDb, runs `fn`, always cleans up. The
 * 95% case for integration tests. Returns whatever `fn` returns.
 *
 * @example
 *   import { withTestDb } from '@zveltio/sdk/testing';
 *   import myExtension from '../engine';
 *
 *   test('extension creates contact rows', async () => {
 *     await withTestDb(async (db) => {
 *       await db.schema.createTable('zvd_contacts').addColumn(...).execute();
 *       const ctx = createTestContext({ db });
 *       const app = await createTestApp(myExtension, { ctx });
 *       const res = await app.request('/ext/my/contacts', { method: 'POST', ... });
 *       expect(res.status).toBe(201);
 *       const rows = await db.selectFrom('zvd_contacts').selectAll().execute();
 *       expect(rows).toHaveLength(1);
 *     });
 *   });
 */
export async function withTestDb<T>(
  fnOrOpts: ((db: Kysely<any>) => Promise<T>) | WithTestDbOptions,
  maybeFn?: (db: Kysely<any>) => Promise<T>,
): Promise<T> {
  const opts: WithTestDbOptions = typeof fnOrOpts === 'function' ? {} : fnOrOpts;
  const fn = typeof fnOrOpts === 'function' ? fnOrOpts : maybeFn!;
  if (typeof fn !== 'function') {
    throw new Error('withTestDb: callback is required');
  }
  const handle = await startTestDb(opts);
  try {
    return await fn(handle.db);
  } finally {
    await handle.cleanup();
  }
}

/**
 * Apply an ordered list of SQL strings against the db. Each entry runs in
 * its own statement; semicolons in the source string split into multiple
 * statements. Useful for replaying engine + extension migrations against
 * the test db.
 *
 * @example
 *   import { readFileSync } from 'fs';
 *   import { sync as glob } from 'glob';
 *   const files = glob('engine/migrations/*.sql').map((p) => readFileSync(p, 'utf8'));
 *   await applyMigrationStrings(db, files);
 */
export async function applyMigrationStrings(db: Kysely<any>, sqlStrings: string[]): Promise<void> {
  const { sql } = await loadKysely();
  for (const raw of sqlStrings) {
    const statements = splitStatements(raw);
    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (!trimmed) continue;
      await sql.raw(trimmed).execute(db);
    }
  }
}

/**
 * Same as `applyMigrationStrings` but takes file paths. Reads each file
 * synchronously, applies in order. Bun-native — uses `Bun.file()`.
 */
export async function applyMigrationFiles(db: Kysely<any>, paths: string[]): Promise<void> {
  // Bun.file().text() returns a Promise<string>.
  const contents = await Promise.all(paths.map((p) => Bun.file(p).text()));
  return applyMigrationStrings(db, contents);
}

/**
 * Stop any reuse-cached container. Call this from a `globalTeardown` /
 * `afterAll` so test runs don't leave dangling containers. No-op when no
 * reuse container is active.
 */
export async function stopReusedTestDb(): Promise<void> {
  if (_sharedClient) {
    try {
      await _sharedClient.end();
    } catch {
      /* */
    }
    _sharedClient = null;
  }
  if (_sharedContainer) {
    try {
      await _sharedContainer.stop();
    } catch {
      /* */
    }
    _sharedContainer = null;
  }
}

// ── Internals ───────────────────────────────────────────────────────────────

/** Open a pg connection pool. Uses `pg` (peer dep with testcontainers). */
async function openPgPool(connectionString: string): Promise<any> {
  const pg = await import('pg').catch(() => {
    throw new Error(
      `withTestDb requires the 'pg' npm package. Install it alongside testcontainers:\n` +
        `  bun add -d testcontainers pg @types/pg`,
    );
  });
  // pg's Pool — the Kysely PostgresDialect accepts this directly.
  return new (pg as any).Pool({ connectionString });
}

/**
 * Naive SQL statement splitter: splits on `;` outside of single-quoted
 * strings and dollar-quoted blocks (`$$...$$`). Handles the migration-file
 * styles Zveltio ships; not a full SQL parser.
 *
 * Public so tests can pin its behavior. Not part of the documented surface.
 */
export function splitStatements(src: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    // Comments: -- to end of line
    if (ch === '-' && src[i + 1] === '-') {
      while (i < src.length && src[i] !== '\n') {
        buf += src[i++];
      }
      continue;
    }
    // Block comments: /* ... */
    if (ch === '/' && src[i + 1] === '*') {
      buf += src[i++];
      buf += src[i++];
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        buf += src[i++];
      }
      if (i < src.length) {
        buf += src[i++];
        buf += src[i++];
      }
      continue;
    }
    // Single-quoted strings: handle escaped quotes.
    if (ch === "'") {
      buf += src[i++];
      while (i < src.length) {
        if (src[i] === "'" && src[i + 1] === "'") {
          buf += src[i++];
          buf += src[i++];
          continue;
        }
        if (src[i] === "'") {
          buf += src[i++];
          break;
        }
        buf += src[i++];
      }
      continue;
    }
    // Dollar-quoted blocks: $$ ... $$ or $tag$ ... $tag$.
    if (ch === '$') {
      const tagMatch = src.slice(i).match(/^\$[a-zA-Z0-9_]*\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        buf += tag;
        i += tag.length;
        const endIdx = src.indexOf(tag, i);
        if (endIdx < 0) {
          buf += src.slice(i);
          i = src.length;
          break;
        }
        buf += src.slice(i, endIdx + tag.length);
        i = endIdx + tag.length;
        continue;
      }
    }
    if (ch === ';') {
      out.push(buf);
      buf = '';
      i++;
      continue;
    }
    buf += src[i++];
  }
  if (buf.trim()) out.push(buf);
  return out;
}

// ── Internal helpers for tests only ────────────────────────────────────────
export const _internalForTests = { splitStatements };
