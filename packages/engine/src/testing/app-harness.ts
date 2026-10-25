/**
 * In-process app harness (Phase C).
 *
 * Boots the REAL Hono app inside the current test process and returns it so
 * tests can drive routes with `app.request('/api/...')`. Because the handlers,
 * write-pipeline, and middleware then execute in-process, `bun test --coverage`
 * counts them — unlike the integration suite, which spawns a separate engine
 * (`bun src/index.ts`) and hits it over HTTP, invisible to coverage.
 *
 * Needs a real, migrated Postgres. Point it at one via TEST_DATABASE_URL,
 * never DATABASE_URL alone: the harness migrates the database it is given,
 * makes god users in it and drops tables, and a developer's DATABASE_URL names
 * their own database (a unit run with it set migrated that). Unset,
 * `harnessAvailable()` is false and harness tests skip — so a plain `bun test`
 * over the whole tree still passes locally; CI runs these under a Postgres
 * service.
 *
 * The per-file skip is honest; the LANE's summary was not. `bun test
 * src/tests/harness` exited 0 having run nothing at all, which is the shape this
 * repository has already been bitten by twice. `harness/requires-database.test.ts`
 * now fails the lane when it has no database, unless ZVELTIO_ALLOW_MISSING_DB=1
 * says the skipping is deliberate.
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
import {
  DEFAULT_TENANT_ID,
  getEnforcer,
  grantMemberRole,
  invalidateGodCache,
  invalidateUserPermCache,
  publishEveryTenant,
} from '../lib/tenancy/index.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;

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
      'app-harness: no TEST_DATABASE_URL set. Guard the test with harnessAvailable().',
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
 * Run `fn` in a transaction as `tenantId`, the way the engine writes a firm's rows.
 *
 * The documented install runs the engine as a NOSUPERUSER NOBYPASSRLS owner
 * (`scripts/bootstrap-db-role.sh`), and FORCE RLS binds that connection too: on
 * the bare pool, with no tenant set, a policed table takes and shows only the
 * default tenant's rows. A fixture for another firm written there is refused —
 * on a superuser it was silently accepted, which is how 300 harness tests came
 * to depend on a privilege production does not have (L32). Stays the owner.
 */
export function asTenant<T>(
  db: Database,
  tenantId: string,
  fn: (trx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('zveltio.current_tenant', ${tenantId}, true)`.execute(trx);
    return fn(trx);
  });
}

/**
 * Run `fn` in a transaction that READS (and so deletes) every firm's rows, for a
 * test's own checks and cleanup — the reach `withEveryTenant` gives the engine's
 * background work, staying the owner. Writes still need `asTenant`, and so does
 * a row whose `tenant_id` has no `zv_tenants` row: every firm is the firms that
 * exist.
 */
export function asEveryTenant<T>(db: Database, fn: (trx: Database) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await publishEveryTenant(trx);
    return fn(trx);
  });
}

/**
 * Whether the harness connection is a superuser (every lane but the owner one).
 * A test that impersonates the documented owner role — creating one and taking
 * it on — only needs to on a superuser: on the owner lane it already IS that
 * role, and may not take on a role it created.
 */
export async function connectedAsSuperuser(db: Database): Promise<boolean> {
  const r = await sql<{ s: boolean }>`
    SELECT rolsuper AS s FROM pg_roles WHERE rolname = current_user`.execute(db);
  return r.rows[0]?.s === true;
}

let _superuserUrl: Promise<string | null> | undefined;

/**
 * A superuser connection string to the harness database, for test SETUP only a
 * superuser may do: CREATE DATABASE, a cluster role created or renamed, an
 * INVALID index forged in pg_index, triggers switched off. Never for the
 * engine's own path — that runs as whatever the harness connects as.
 *
 * TEST_SUPERUSER_DATABASE_URL when set (the owner lane sets it), else the
 * harness URL when that is a superuser (every other lane), else null: the
 * caller skips, naming the variable, rather than failing on a privilege the
 * documented install does not have.
 */
export function superuserUrl(): Promise<string | null> {
  _superuserUrl ??= (async () => {
    if (process.env.TEST_SUPERUSER_DATABASE_URL) return process.env.TEST_SUPERUSER_DATABASE_URL;
    if (!TEST_DB_URL) return null;
    const { createDb } = await import('../db/index.js');
    const probe = createDb(TEST_DB_URL);
    try {
      return (await connectedAsSuperuser(probe)) ? TEST_DB_URL : null;
    } finally {
      await probe.destroy();
    }
  })();
  return _superuserUrl;
}

/** The title of a describe `superuserUrl()` gates: a skip says what it needs. */
export const superuserTitle = (title: string, url: string | null): string =>
  url ? title : `${title} (needs a superuser: set TEST_SUPERUSER_DATABASE_URL)`;

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
  // A demoted god is a member, which only Casbin says (`g <user> member *`).
  for (const row of demoted.rows) await grantMemberRole(row.id);
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
 * A god session that can step up (lib/step-up.ts): a software passkey enrolled
 * the way the Studio does, behind the password. `stepUp(action)` is the header
 * one extension mutation needs; each call mints a fresh single-use token.
 *
 * `app` is the engine behind one door that does that for its caller: a request
 * carrying exactly this god's cookie to an extension mutation gets a fresh token
 * on the way in, so suites about what a mutation DOES need not re-spell how it is
 * confirmed. `god-step-up.test.ts` is where the confirmation itself is tested.
 */
export async function createSteppedUpGod(
  app: Hono,
  db: Database,
): Promise<{ cookie: string; app: Hono; stepUp(action: string): Promise<Record<string, string>> }> {
  const { newSoftPasskey, registerSoftPasskey, passkeyStepUp, stepUpActionFor } = await import(
    './step-up.js'
  );
  const { passkeyRelyingParty } = await import('../lib/auth.js');
  const { Hono: HonoApp } = await import('hono');
  const { origin } = passkeyRelyingParty();
  const req = (path: string, init?: RequestInit) => app.request(path, init);
  const cookie = await createGodSession(app, db);
  const pk = await newSoftPasskey();
  const reg = await registerSoftPasskey(req, cookie, pk, origin, { password: 'HarnessGod123!' });
  if (!reg.ok)
    throw new Error(`harness passkey enrollment failed: ${reg.status} ${await reg.text()}`);
  const stepUp = async (action: string) => ({
    'X-Zveltio-Step-Up': await passkeyStepUp(req, cookie, pk, action, origin),
  });
  const door = new HonoApp();
  door.all('*', async (c) => {
    const raw = c.req.raw;
    const action = stepUpActionFor(raw.method, new URL(raw.url).pathname);
    if (!action || raw.headers.get('cookie') !== cookie) return app.fetch(raw);
    const headers = new Headers(raw.headers);
    headers.set('X-Zveltio-Step-Up', (await stepUp(action))['X-Zveltio-Step-Up']);
    return app.fetch(new Request(raw, { headers }));
  });
  return { cookie, app: door, stepUp };
}

/**
 * A signed-in user who is NOT god, plus its id.
 *
 * Needed because `createGodSession` is the only session most harness suites
 * have, and god is exempt from access controls by design — so a suite that
 * drives a restriction through a god session cannot observe the restriction.
 * The column-permission suites did exactly that. They passed while
 * `getColumnAccess` masked god (a bug: the exemption named `admin`, and `god`
 * fell through to being masked), and began failing the moment the exemption
 * became a permission that god actually holds. The tests were green because of
 * the defect they were meant to catch.
 *
 * The user is a `member`: the CHECK constraint on `"user".role` permits only
 * `god` and `member`. It once offered `admin` and `manager` too, which the
 * constraint refuses — no suite used them, so nobody noticed.
 *
 * Returns the id as well as the cookie because column and row rules are keyed
 * by identity, and a test that plants a rule needs to name the subject.
 */
export async function createMemberSession(
  app: Hono,
  db: Database,
  opts: {
    role?: 'member';
    /**
     * Collections this user may act on, and how. Required for almost every
     * test: `checkAccess` resolves `checkPermission(user.id, collection,
     * action)` and the engine is deny-by-default, so a member with no policy is
     * refused 403 — which looks nothing like the masking a column test is
     * trying to observe, and is easy to misread as the restriction working.
     *
     * Granted per user rather than per role so a suite cannot leak authority
     * into another suite through a shared role name.
     */
    grants?: Array<{ collection: string; actions: string[] }>;
  } = {},
): Promise<{ cookie: string; userId: string; email: string }> {
  const role = 'member';
  const email = `harness-${role}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
  const password = 'HarnessMember123!';

  const signUp = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: `Harness ${role}` }),
  });
  if (!signUp.ok && signUp.status !== 200 && signUp.status !== 201) {
    throw new Error(`harness sign-up failed: ${signUp.status} ${await signUp.text()}`);
  }

  // No god demotion here, deliberately: this helper must be usable alongside
  // `createGodSession` in the same suite, which is how a test shows that the
  // same rule binds one identity and not the other.
  const row = await sql<{ id: string }>`
    UPDATE "user" SET role = ${role} WHERE email = ${email} RETURNING id
  `.execute(db);
  const userId = row.rows[0]?.id;
  if (!userId) throw new Error(`harness could not find the ${role} it just created`);

  // Same reason as in `createGodSession`: the role is written in raw SQL behind
  // `isGodUser`'s in-process cache, which the sign-up request has already
  // populated for this account.
  await invalidateGodCache(userId);

  if (opts.grants?.length) {
    const enforcer = await getEnforcer();
    for (const grant of opts.grants) {
      for (const action of grant.actions) {
        await enforcer.addPolicy(userId, '*', grant.collection, action);
      }
    }
    // `checkPermission` memoises per user; the policies were just added behind
    // that memo.
    await invalidateUserPermCache(userId);
  }

  const signIn = await app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const cookie = (signIn.headers.get('set-cookie') ?? '')
    .split(',')
    .map((c) => c.split(';')[0]!.trim())
    .filter(Boolean)
    .join('; ');
  if (!cookie) {
    throw new Error(`harness sign-in returned no cookie: ${signIn.status} ${await signIn.text()}`);
  }
  return { cookie, userId, email };
}

/**
 * A user to stand as `created_by` of an API key a test inserts by hand: a key
 * with no creator never authenticates (`usableApiKeys`). A key bound to an
 * ordinary tenant acts there on its creator's membership, so the creator is
 * enrolled in each of `tenantIds` that exists — the default tenant counts
 * everyone, and a tenant that does not exist cannot be joined.
 * An administrator — see `asKeyIssuer`.
 */
export async function createKeyCreator(db: Database, tenantIds: string[] = []): Promise<string> {
  const id = `harness-keycreator-${crypto.randomUUID()}`;
  await sql`INSERT INTO "user" (id, name, email)
            VALUES (${id}, 'Harness key creator', ${`${id}@test.local`})`.execute(db);
  await asKeyIssuer(id);
  for (const tenantId of tenantIds) {
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role)
              SELECT id, ${id}, 'member' FROM zv_tenants
              WHERE id = ${tenantId}::uuid AND id <> ${DEFAULT_TENANT_ID}::uuid
              ON CONFLICT DO NOTHING`.execute(db);
  }
  return id;
}

/**
 * Make `userId` an administrator (`admin`, which holds `('*','*')` everywhere),
 * as the people who mint keys are, and return it: a key never exceeds its
 * issuer (`keyIssuerAllows`), so a hand-inserted key's reach is then its scopes
 * alone. Not god, so the issuer's tenant membership still binds the key.
 */
export async function asKeyIssuer(userId: string): Promise<string> {
  await (await getEnforcer()).addRoleForUser(userId, 'admin', '*');
  await invalidateUserPermCache(userId);
  return userId;
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
  // The ghost artefacts go with it. `atomicSwap` renames the original to
  // `_zv_old_<table>` and schedules dropping that and `_zv_changelog_<table>`
  // sixty seconds later, which is long after a test process is gone — so any
  // suite that ran a Ghost DDL migration leaves two tables behind, and
  // `check:test-leftovers` fails the whole run on them. Several ghost tests
  // already hand-roll this list in their own `afterAll`; doing it here is what
  // makes the next test that forgets to copy it harmless.
  for (const t of [`_zv_changelog_${table}`, `_zv_old_${table}`, table]) {
    await sql.raw(`DROP TABLE IF EXISTS "${t}" CASCADE`).execute(db);
  }
  await sql`DELETE FROM zvd_collections WHERE name = ${bare}`.execute(db);
  // Its grants too (the boot reconcile writes defaults): left behind, a rerun's
  // create of the same name is refused for adopting them (A13).
  await sql`DELETE FROM zvd_permissions WHERE ptype = 'p' AND v2 = ${bare}`.execute(db);
  // And the default grants revoked on it: removing its rules through the
  // enforcer records each default as revoked, and those rows outlive the name.
  await sql`DELETE FROM zv_default_grant_revocations WHERE resource = ${bare}`.execute(db);
}

/**
 * The socket data `/api/ws` hands to `websocketHandler.open`, from the real
 * upgrade through a stand-in `server` — so a probe socket carries the principal
 * the realtime sweep re-asks. `undefined` when the upgrade was refused.
 */
export async function wsUpgradeData(
  app: Hono,
  headers: Record<string, string>,
): Promise<Record<string, unknown> | undefined> {
  let data: Record<string, unknown> | undefined;
  const server = {
    upgrade: (_req: Request, opts: { data: Record<string, unknown> }) => {
      data = opts.data;
      return true;
    },
  };
  await app.request('/api/ws', { headers }, { server });
  return data;
}

/**
 * An actor holding every collection grant — for tests whose subject is not
 * permissions (roles, triggers, DDL inside a request) but which run extension or
 * worker statements in a tenant transaction. Collection permissions (R1) give an
 * extension's statement nothing without an actor; a real request always has one.
 */
export const ALL_COLLECTIONS_ACTOR = {
  userId: '',
  email: '',
  role: '',
  roles: [] as string[],
  bypass: false,
  collectionGrants: '',
  collectionAll: true,
  anonymous: true,
};

/**
 * `POST /api/sync/pull`, waiting out the watermark fail-safe (#738).
 *
 * While a session the engine's role cannot inspect is inside a transaction
 * (another test file's, on CI; often on the non-superuser lane) the watermark
 * is 0: the pull delivers nothing, keeps every cursor it was given and says
 * `hasMore: false`. A test reads that as "caught up". A real caught-up pull
 * moves the cursor's deletes position to the new watermark, so a page that is
 * empty AND hands back exactly the cursors it got is the fail-safe: retry.
 * `sync-pull-watermark.test.ts` asserts the fail-safe itself and must not use this.
 */
export async function syncPull(
  app: Hono,
  cookie: string,
  body: { cursors?: Record<string, string> } & Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  for (let attempt = 0; ; attempt++) {
    const res = await app.request('/api/sync/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
    const out = (await res.json()) as {
      changes?: unknown[];
      hasMore?: boolean;
      cursors?: Record<string, string>;
    };
    const held =
      res.status === 200 &&
      out.changes?.length === 0 &&
      !out.hasMore &&
      Object.entries(out.cursors ?? {}).every(([k, v]) => body.cursors?.[k] === v);
    if (!held || attempt === 20) return { status: res.status, body: out };
    await Bun.sleep(100);
  }
}

/**
 * Move god status to the account at `email` the only way the product allows —
 * recovery (`POST /api/permissions/bootstrap`) — which demotes the current god.
 * `PATCH /api/users/:id` refuses to change god status (#1161). Each call brings
 * a fresh `RECOVERY_TOKEN`, since a token is spent on use.
 */
export async function recoverGod(
  app: Hono,
  email: string,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  const saved = process.env.RECOVERY_TOKEN;
  const token = `harness-recovery-${crypto.randomUUID()}`;
  process.env.RECOVERY_TOKEN = token;
  try {
    return await app.request('/api/permissions/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email, ...extra }),
    });
  } finally {
    if (saved === undefined) delete process.env.RECOVERY_TOKEN;
    else process.env.RECOVERY_TOKEN = saved;
  }
}
