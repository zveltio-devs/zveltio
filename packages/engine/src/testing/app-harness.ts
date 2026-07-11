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
import { sql } from 'kysely';
import type { Database } from '../db/index.js';

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

  await sql`UPDATE "user" SET role = 'god' WHERE email = ${email}`.execute(db);

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
