/**
 * In-process app harness (Phase C).
 *
 * Boots the REAL Hono app inside the current test process and returns it so
 * tests can drive routes with `app.request('/api/...')`. Because the handlers,
 * write-pipeline, and middleware then execute in-process, `bun test --coverage`
 * counts them — unlike the integration suite, which spawns a separate engine
 * (`bun src/index.ts`) and hits it over HTTP, invisible to coverage.
 *
 * Needs a real, migrated Postgres. Point it at one via TEST_DATABASE_URL
 * (falls back to DATABASE_URL). When neither is set, `harnessAvailable()` is
 * false and harness tests skip — so a plain `bun test` with no database still
 * passes locally; CI runs these under a Postgres service.
 *
 *   const { app, db } = await getTestApp();
 *   const cookie = await createGodSession(app, db);
 *   const res = await app.request('/api/collections', { headers: { cookie } });
 */

import type { Hono } from 'hono';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { invalidateGodCache } from '../lib/tenancy/index.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

/** True when a test database is configured; harness tests should skip otherwise. */
export function harnessAvailable(): boolean {
  return Boolean(TEST_DB_URL);
}

let _cached: { app: Hono; db: Database } | null = null;

/**
 * Boot (once per process) the real app against the test database and return it.
 * Idempotent — repeated calls reuse the same app + db.
 */
export async function getTestApp(): Promise<{ app: Hono; db: Database }> {
  if (_cached) return _cached;
  if (!TEST_DB_URL) {
    throw new Error(
      'app-harness: no TEST_DATABASE_URL (or DATABASE_URL) set. Guard the test with harnessAvailable().',
    );
  }

  // The engine reads DATABASE_URL; the secrets are required by auth + field
  // crypto. Defaults are deterministic and test-only.
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.NODE_ENV = 'test';
  process.env.BETTER_AUTH_SECRET ??= 'test-secret-minimum-32-characters-long-xx';
  process.env.FIELD_ENCRYPTION_KEY ??= '0'.repeat(64);
  // Don't let a stray VALKEY_URL make the realtime bus try to connect.
  delete process.env.VALKEY_URL;
  // The harness is what multiplies pools: 255 test files, each booting an engine
  // with its own pool, against ONE Postgres. That — not any real deployment —
  // is what exhausted connections when the shipped default was raised once
  // before, so the small number belongs here, where the multiplicity is.
  //
  // 10, which is exactly what the harness inherited before the product default
  // moved — so raising that default changes nothing here. 5 was tried and made
  // the suite several times slower.
  //
  // `??=`, so CI's workflow-level `DB_POOL_MAX` wins: there the harness is not
  // the only engine running against that Postgres, and the integration job adds
  // one more outside this file entirely. That is how 25 first reached CI as
  // "sorry, too many clients already" — this default covered the harness and
  // nothing else.
  process.env.DB_POOL_MAX ??= '10';

  // Every test gets its own extensions directory, outside the repository.
  //
  // `resolveExtensionsBase()` falls back to `./extensions` under the working
  // directory, which is the repo root when tests run — so any test that installs
  // an extension writes a generated bundle into the tree and leaves it there.
  // `lint:ratchet` then scans that bundle and fails on warnings nobody wrote,
  // on a branch that changed no source. That cost twenty minutes today, on a
  // dependency-bump branch where the obvious suspect was the dependency bump.
  //
  // `marketplace.test.ts` already did this for itself. One test defending the
  // tree only defends it from that test; this is the boundary every test crosses.
  if (!process.env.EXTENSIONS_DIR) {
    process.env.EXTENSIONS_DIR = mkdtempSync(join(tmpdir(), 'zv-harness-ext-'));
  }

  const { initDatabase } = await import('../db/index.js');
  const db = await initDatabase();

  const { autoMigrate } = await import('../db/auto-migrate.js');
  await autoMigrate(db);

  const { _createAppForTests } = await import('../index.js');
  const app = await _createAppForTests(db);

  _cached = { app, db };
  return _cached;
}

/**
 * Create a fresh god user and return its signed session cookie by driving the
 * real auth routes THROUGH the in-process app (so auth handlers are covered
 * too). The user is promoted to `god` directly in the DB after sign-up.
 */
export async function createGodSession(app: Hono, db: Database): Promise<string> {
  const email = `harness-god-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
  const password = 'HarnessGod123!';

  const signUp = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'Harness God' }),
  });
  if (!signUp.ok && signUp.status !== 200 && signUp.status !== 201) {
    throw new Error(`harness sign-up failed: ${signUp.status} ${await signUp.text()}`);
  }

  // One god at a time, because that is what the product says and what the
  // database now enforces (migration 008). Each suite makes its own god user,
  // so the previous one is stood down first — without this, the second suite in
  // a run is refused and 248 tests fail on an invariant they are not about.
  //
  // Demoting rather than reusing keeps every suite's session its own: they run
  // in one process against one database, and a shared cookie would couple them.
  const demoted = await sql<{ id: string }>`
    UPDATE "user" SET role = 'member' WHERE role = 'god' AND email <> ${email} RETURNING id
  `.execute(db);
  const granted = await sql<{ id: string }>`
    UPDATE "user" SET role = 'god' WHERE email = ${email} RETURNING id
  `.execute(db);

  // Clear the god caches, exactly as the product's own transfer route does.
  //
  // `isGodUser` answers from a 5-second in-process cache, so a role changed
  // behind its back is invisible for that long. The product never changes a role
  // behind its back — `routes/permissions.ts` returns the affected ids precisely
  // so it can invalidate them — but this helper writes the role in raw SQL, and
  // so used to leave the cache saying the opposite of the database.
  //
  // That is not a theoretical staleness. `POST /api/auth/sign-up/email` runs the
  // full middleware chain, and `tenantMembershipMiddleware` calls `isGodUser` on
  // the way through — caching FALSE for the brand-new account a line before this
  // promotes it. Every subsequent request in the suite was then refused 403 by a
  // membership check the real god is exempt from.
  //
  // It stayed hidden because that middleware returns early when the resolved
  // tenant is the default one, which is the only tenant a virgin database has.
  // So the suite passed on a fresh database and failed on any database with real
  // tenants in it — i.e. it was blind on precisely the multi-tenant path the
  // product is for. Measured on one 63-tenant database: 108 failures, all of
  // them this, none of them the code under test.
  for (const row of [...demoted.rows, ...granted.rows]) {
    await invalidateGodCache(row.id);
  }

  const signIn = await app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const setCookie = signIn.headers.get('set-cookie') ?? '';
  const cookie = setCookie
    .split(',')
    .map((c) => c.split(';')[0]!.trim())
    .filter(Boolean)
    .join('; ');
  if (!cookie) {
    throw new Error(`harness sign-in returned no cookie: ${signIn.status} ${await signIn.text()}`);
  }
  return cookie;
}

/**
 * Undo a collection a test created — the table AND the row that names it.
 *
 * Dropping only the table is what every test here did, and it is half the job:
 * `zvd_collections` keeps the row, so the collection still exists as far as the
 * engine is concerned. One leftover per test file is invisible; thirty runs of
 * the suite left 163 of them in a shared database, and a measurement taken there
 * reported authorization at 364 ms per decision when the real figure on a real
 * instance is 0,93 ms. That number reached two written reports before anyone
 * checked how many collections a real install has.
 *
 * So this is not tidiness. A test that leaves state behind is a test that can
 * make the next measurement lie.
 *
 * `CASCADE` because a collection under test may have grown indexes, triggers or
 * a changelog; `IF EXISTS` because a test that already dropped the table should
 * still be able to drop the row.
 */
export async function dropTestCollection(db: Database, name: string): Promise<void> {
  const table = name.startsWith('zvd_') ? name : `zvd_${name}`;
  const bare = table.slice('zvd_'.length);
  // The interpolation below is quoted, so a name carrying a double quote would
  // break out of it. Collection names are SAFE_NAME everywhere else in the
  // engine; a test handing this anything else gets an error, not broken SQL.
  const SAFE_NAME = /^[a-z][a-z0-9_]*$/;
  if (!SAFE_NAME.test(bare)) throw new Error(`Invalid test collection name: "${name}"`);
  await sql.raw(`DROP TABLE IF EXISTS "${table}" CASCADE`).execute(db);
  await sql`DELETE FROM zvd_collections WHERE name = ${bare}`.execute(db);
}
