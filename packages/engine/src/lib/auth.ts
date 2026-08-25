import { AsyncLocalStorage } from 'node:async_hooks';
import { runWithoutTenantTrx } from './tenancy/index.js';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { twoFactor } from 'better-auth/plugins';
import { magicLink } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import { Kysely } from 'kysely';
import { BunSqlDialect } from '../db/bun-sql-dialect.js';
import type { Database } from '../db/index.js';
import { withIdleInTransactionTimeout } from '../db/index.js';
import type { DbSchema } from '../db/schema.js';

let _auth: ReturnType<typeof betterAuth> | null = null;

// ── Self-registration: one chokepoint instead of one per flow ───────────────
//
// The registration gate is HTTP middleware on `POST /api/auth/sign-up/*`. That
// covers exactly one way to acquire an account. Magic link found the gap first
// — it signs people in, so it is not a sign-up route, and it created users
// until `disableSignUp: true` was added. OAuth had the same shape and no such
// flag: on any instance with a social provider configured, and with
// `registration_enabled` at its default of OFF, signing in with an unknown
// Google account created one.
//
// Rather than chase each plugin, the check moves to the single thing every
// flow must do — insert a row into `user`. A `before` hook there is
// provider-agnostic and evaluated per request, so toggling the setting still
// takes effect without a restart, and a plugin added next year is covered on
// the day it ships.
//
// Two paths legitimately create users while self-registration is off: an admin
// consuming an invitation, and the CLI creating the first god user. Both run
// in-process rather than over HTTP, so they announce themselves through this
// ALS rather than by being absent from a URL pattern.
const authorizedUserCreation = new AsyncLocalStorage<true>();

/**
 * Run `fn` with permission to create a user even when self-registration is
 * disabled. For deliberate, already-authorized creation only — an admin's
 * invitation or the CLI's first-user bootstrap.
 */
export function withAuthorizedUserCreation<T>(fn: () => Promise<T>): Promise<T> {
  return authorizedUserCreation.run(true, fn);
}

// ── S4-09: scrypt → argon2id silent migration ──────────────────────────────
//
// When a legacy scrypt verification succeeds, we re-hash the password with
// argon2id and write it back to better-auth's `account` table. The next
// sign-in for the same user hits the argon2id branch and finishes faster.
//
// PASSWORD_LEGACY_SCRYPT_DEADLINE (ISO date) is a hard cut-off: after that
// date, scrypt verification is refused even on correct input. Operators
// monitor `countLegacyScryptHashes(db)` to know when it's safe to set the
// deadline — typically 90 days after the first deployment of this code.
// Default: unset, meaning "accept scrypt indefinitely".

function isLegacyScryptDeadlinePassed(): boolean {
  const deadline = process.env.PASSWORD_LEGACY_SCRYPT_DEADLINE;
  if (!deadline) return false;
  const d = new Date(deadline);
  if (Number.isNaN(d.getTime())) return false;
  return Date.now() > d.getTime();
}

/**
 * Argon2id tuning. Default (4 MB memory, 3 iterations) is intentionally
 * low so create-god + login still work on the smallest deployment VMs.
 * Operators on real hardware should bump these via env vars — OWASP
 * recommends ≥19 MB for argon2id in 2024. Clamped to sane upper bounds
 * so a typo doesn't make every login take 30 seconds.
 */
function argonMemoryCost(): number {
  const env = parseInt(process.env.ARGON_MEMORY_COST_KIB || '', 10);
  if (Number.isFinite(env) && env >= 1024 && env <= 1_048_576) return env;
  return 4096;
}
function argonTimeCost(): number {
  const env = parseInt(process.env.ARGON_TIME_COST || '', 10);
  if (Number.isFinite(env) && env >= 1 && env <= 20) return env;
  return 3;
}

function argonOptions(): { algorithm: 'argon2id'; memoryCost: number; timeCost: number } {
  return { algorithm: 'argon2id', memoryCost: argonMemoryCost(), timeCost: argonTimeCost() };
}

function hashPassword(password: string) {
  return Bun.password.hash(password, argonOptions());
}

async function verifyPassword({
  hash,
  password,
}: {
  hash: string;
  password: string;
}): Promise<boolean> {
  // New hashes: argon2id / bcrypt — start with '$'
  if (hash.startsWith('$')) {
    return Bun.password.verify(password, hash);
  }
  // S4-09: legacy scrypt path. Verify, then schedule a silent
  // re-hash so the next sign-in goes through the argon2id branch.
  if (isLegacyScryptDeadlinePassed()) {
    console.warn('[auth] Refusing legacy scrypt hash — past PASSWORD_LEGACY_SCRYPT_DEADLINE.');
    return false;
  }
  // Legacy hashes: better-auth default scrypt format "salt:hexkey"
  const [salt, key] = hash.split(':');
  if (!salt || !key) return false;
  try {
    const { scryptSync } = await import('crypto');
    const derived = scryptSync(password, salt, 64, { N: 16384, r: 16, p: 1 });
    if (derived.toString('hex') !== key) return false;
    // Schedule re-hash — fire-and-forget so a DB error doesn't
    // block sign-in. The user is already authenticated.
    rehashLegacyAccountToArgon2id(_authDb, hash, password).catch((err) => {
      console.warn('[auth] Re-hash to argon2id failed (will retry on next login):', err.message);
    });
    return true;
  } catch {
    return false;
  }
}

/** Patched getSession wrapper — exported for unit tests. */
export function wrapGetSession<T extends (...args: never[]) => Promise<unknown>>(orig: T): T {
  return (async (...args: Parameters<T>) => {
    try {
      return await orig(...args);
    } catch (err) {
      if (isBenignGetSessionError(err)) {
        return null;
      }
      const e = err as { message?: string };
      console.error('[getSession] Unexpected error — re-throwing:', e?.message ?? err);
      throw err;
    }
  }) as T;
}

/**
 * Rewrite a successful scrypt verification's password column with a
 * fresh argon2id hash. Lookups by the old hash value — better-auth stores
 * one row per (user, provider) in `account`, and the password is unique
 * enough (per-user salt) to identify the row.
 *
 * Fire-and-forget; failures are logged but don't fail the sign-in.
 */
async function rehashLegacyAccountToArgon2id(
  db: Database | null,
  oldHash: string,
  password: string,
): Promise<void> {
  if (!db) return;
  const row = await db
    .selectFrom('account')
    .select(['id', 'password'])
    .where('password', '=', oldHash)
    .executeTakeFirst();
  if (!row) return; // row updated already by a concurrent login? Either way: stop.

  const newHash = await Bun.password.hash(password, argonOptions());
  await db
    .updateTable('account')
    .set({ password: newHash, updatedAt: new Date() })
    .where('id', '=', row.id)
    .where('password', '=', oldHash) // optimistic: only update if still scrypt
    .execute();
}

/**
 * Count rows in `account` whose password column still uses the legacy
 * scrypt format (`salt:hexkey`). Operators run this against production to
 * decide when to set `PASSWORD_LEGACY_SCRYPT_DEADLINE`. Returns 0 means
 * "safe to enforce the deadline immediately".
 *
 * Detection: argon2id / bcrypt hashes start with `$`. scrypt rows don't.
 * NULL password (OAuth-only accounts) is excluded.
 */
/**
 * End every session belonging to `userId`, in the database AND in the cache.
 *
 * Deleting the `user` row cascades the `session` table, which looked like
 * enough — but when VALKEY_URL is set, better-auth is given a
 * `secondaryStorage` and reads sessions from THERE first. The cascade never
 * touches it, so a deleted user's cookie kept working until the entry aged out
 * of the cache. Deactivating an account is the one moment where "eventually"
 * is the wrong answer, and the recommended production setup is precisely the
 * one that has the cache.
 *
 * better-auth keeps `active-sessions-<userId>` as a list of `{ token }` and a
 * separate entry per token, so both have to go. The list is read through the
 * raw cache client rather than the adapter because the adapter is only handed
 * to better-auth; the value is double-encoded (the adapter JSON-stringifies
 * what better-auth already stringified), which is why it is parsed twice.
 *
 * Best-effort on the cache: a purge that throws must not stop an administrator
 * from deleting an account. The DB rows are removed either way, so the session
 * cannot outlive the cache TTL even in the worst case.
 */
export async function revokeAllUserSessions(
  db: Database,
  userId: string,
  /**
   * A session token to spare. Used when the reason for revoking is that the
   * user just hardened their own account — logging them out of the tab they
   * did it in would read as a failure, not as protection.
   */
  exceptToken?: string,
): Promise<void> {
  const { getCache } = await import('./runtime/index.js');
  const cache = getCache();
  if (cache) {
    try {
      const raw = await cache.get(`active-sessions-${userId}`);
      const kept: unknown[] = [];
      if (raw) {
        let list: unknown = raw;
        for (let i = 0; i < 2 && typeof list === 'string'; i++) {
          try {
            list = JSON.parse(list);
          } catch {
            break;
          }
        }
        if (Array.isArray(list)) {
          for (const entry of list) {
            const token = (entry as { token?: string })?.token;
            if (!token) continue;
            if (token === exceptToken) {
              kept.push(entry);
              continue;
            }
            await cache.del(token).catch(() => {});
          }
        }
      }

      // One decision, taken once, whatever the index turned out to be.
      //
      // This was two branches and an unparseable index fell between them: not an
      // array, so nothing rewrote it, and not absent, so nothing deleted it —
      // the malformed entry survived a revocation whose whole job is to leave
      // nothing behind. Rewriting when a session is spared keeps it visible to
      // `listSessions`, and present-but-unlistable is its own kind of broken.
      // Double-encoded on the way in, matching how the adapter stores what
      // better-auth already stringified.
      if (kept.length > 0) {
        await cache
          .set(`active-sessions-${userId}`, JSON.stringify(JSON.stringify(kept)))
          .catch(() => {});
      } else {
        await cache.del(`active-sessions-${userId}`).catch(() => {});
      }
    } catch (err) {
      console.error(`[auth] could not purge cached sessions for ${userId}:`, err);
    }
  }

  // Explicit rather than left to the FK cascade: this runs before the user row
  // is gone, and it is what makes the function correct on its own. It is also
  // the ONLY thing that revokes sessions on the 2FA path, where nothing is being
  // deleted and no cascade can help.
  //
  // `db` must be a PRIVILEGED handle, not the request's tenant-scoped one.
  // Requests run under `SET LOCAL ROLE zveltio_rls`, and migration 044 took that
  // role's grants on `session` away on purpose — reading a bearer token is what
  // C-14 and C-10 did. So this statement cannot run there, and both call sites
  // pass `poolDb`.
  //
  // No `.catch` here any more. It swallowed the JavaScript error and did not
  // un-abort the PostgreSQL transaction, so a `permission denied` surfaced three
  // statements later as `current transaction is aborted` — the only error anyone
  // could see, on a line that had nothing to do with it. The comment said "table
  // shape varies on fresh installs"; the shape was always fine, it was the grant.
  //
  // A failure here has to reach the caller. Revoking sessions is the security
  // half of both operations that call this, and a silent no-op is the worst
  // possible outcome: the account looks hardened and every other session lives.
  let del = db.deleteFrom('session').where('userId', '=', userId);
  if (exceptToken) del = del.where('token', '!=', exceptToken);
  await del.execute();
}

export async function countLegacyScryptHashes(db: Database): Promise<number> {
  try {
    const rows = await db
      .selectFrom('account')
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      .select((eb: any) => eb.fn.count('id').as('count'))
      .where('password', 'is not', null)
      // SQL pattern: anything that DOES NOT start with `$`.
      .where('password', 'not like', '$%')
      .executeTakeFirst();
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    return Number((rows as any)?.count ?? 0);
  } catch {
    return 0; // table missing on fresh installs, etc.
  }
}

// Db reference used by the password.verify callback for the re-hash
// side effect. Captured from the initAuth parameter — the verify closure
// reads this module-level binding so it sees the value after init.
let _authDb: Database | null = null;

// Cached transporter — nodemailer's `createTransport` opens a pool when
// `pool: true` is passed, so we want a single shared instance across
// magic-link emails / password resets / verification mails instead of
// reconnecting per send. The transporter is recreated whenever the
// SMTP env vars change shape (e.g. test harness flips them between
// runs); in normal production they're static after process start.
let _smtpTransport: import('nodemailer').Transporter | null = null;
let _smtpFingerprint = '';

function smtpFingerprint(): string {
  return [
    process.env.SMTP_HOST ?? '',
    process.env.SMTP_PORT ?? '',
    process.env.SMTP_SECURE ?? '',
    process.env.SMTP_USER ?? '',
  ].join('|');
}

async function getSmtpTransport(): Promise<import('nodemailer').Transporter> {
  const fp = smtpFingerprint();
  if (_smtpTransport && fp === _smtpFingerprint) return _smtpTransport;
  const { createTransport } = await import('nodemailer');
  _smtpTransport = createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' }
      : undefined,
    pool: true,
    maxConnections: 3,
  });
  _smtpFingerprint = fp;
  return _smtpTransport;
}

async function sendEmail(to: string, subject: string, html: string, text: string) {
  const transport = await getSmtpTransport();
  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@zveltio.com',
    to,
    subject,
    html,
    text,
  });
}

// Re-export auth instance for convenience in routes
export const auth = {
  get api() {
    if (!_auth) throw new Error('Auth not initialized. Call initAuth() first.');
    return _auth.api;
  },
};

export async function initAuth(db: Database) {
  if (!process.env.BETTER_AUTH_SECRET) {
    throw new Error('BETTER_AUTH_SECRET environment variable is required');
  }
  // S4-09: capture db so the password.verify callback can re-hash
  // scrypt → argon2id without taking db as a closure argument.
  _authDb = db;

  const port = process.env.PORT || '3000';
  const baseURL = process.env.BETTER_AUTH_URL || `http://localhost:${port}`;

  // Trusted origins: since studio and client are served by THIS engine (same origin),
  // we need to trust requests from any IP/hostname the server might be accessed via.
  // Detect all local network interfaces and add them as trusted origins.
  const localOrigins: string[] = [baseURL, `http://localhost:${port}`, `https://localhost:${port}`];
  try {
    const { networkInterfaces } = await import('os');
    for (const ifaces of Object.values(networkInterfaces())) {
      for (const iface of ifaces || []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          localOrigins.push(`http://${iface.address}:${port}`);
          localOrigins.push(`https://${iface.address}:${port}`);
        }
      }
    }
  } catch {
    /* non-fatal */
  }

  // CORS_ORIGINS, if set, is the explicit allowlist (split + trim).
  // Otherwise we restrict to the engine's own baseURL plus auto-detected
  // local network interfaces (see localOrigins above) — this covers the
  // self-hosted case where the engine is reached via either localhost
  // or its LAN IP, without echoing arbitrary Origin headers back as
  // "trusted" (which would defeat CSRF protection with `credentials:
  // include` cookies). In production set CORS_ORIGINS explicitly.
  const trustedOrigins: string[] = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',')
        .map((o) => o.trim())
        .filter(Boolean)
    : localOrigins;

  if (!process.env.CORS_ORIGINS && process.env.NODE_ENV === 'production') {
    console.warn(
      '[auth] CORS_ORIGINS is not set in production — falling back to ' +
        `auto-detected origins (${localOrigins.length} entries). Set ` +
        'CORS_ORIGINS explicitly to lock down the allowlist.',
    );
  }

  // Pass the engine's own Kysely (BunSqlDialect) instance to better-auth via the
  // { db, type } object form. createKyselyAdapter detects "db" in database and uses
  // db.db directly with databaseType = "postgres", skipping auto-detection entirely.
  //
  // Why NOT pg.Pool:
  //   - pg.Pool is a Node.js library; Bun's Node compat has subtle socket-level
  //     differences that cause silent connection failures at query time.
  //   - health check uses BunSqlDialect, so pg.Pool failures are invisible until
  //     the first auth request hits the DB.
  //
  // Why NOT BunSqlDialect passed directly (previous attempt):
  //   - createKyselyAdapter detects it via "createDriver" but can't identify the
  //     dialect type → falls back to databaseType = null → type: "sqlite" in the
  //     adapter → wrong SQL generation (no boolean/UUID/JSON support).
  //
  // This form is explicit: we reuse the already-working engine Kysely instance and
  // tell better-auth it's postgres, so all feature flags (booleans, UUIDs, JSON)
  // are enabled correctly.
  // Better Auth gets its OWN pool, never the one tenant transactions run on.
  //
  // A request abandoned mid-transaction — Bun.serve giving up on a slow handler,
  // a client disconnecting — returns its connection to the pool without COMMIT or
  // ROLLBACK, so `SET LOCAL ROLE zveltio_rls` is still in force on it. Postgres
  // reclaims such a transaction after `idle_in_transaction_session_timeout`
  // (60s here), and for that minute the connection is in the pool carrying a role
  // that cannot read `session`. Whoever borrows it next gets
  // `permission denied for table session` — and because that aborts THEIR
  // transaction, one contaminated connection fails a series of unrelated
  // requests. Demonstrated in isolation: release a reserved connection without
  // rolling back and the very next `pool.unsafe()` runs as `zveltio_rls`.
  //
  // Chasing every path that can abandon a transaction was tried and is not
  // winnable from here — the cleanup hook this file's sibling added fires once
  // per nineteen failures, so the rest happens inside the driver. Making the
  // reader immune is bounded and does not depend on catching them.
  //
  // Semantically right as well: `user`, `session`, `account`, `verification`,
  // `twoFactor` and `passkey` are global tables with no RLS by design
  // (migration 044). Nothing about them is tenant-scoped, so they have no
  // business sharing a pool with tenant transactions.
  //
  // Small on purpose. Auth queries are short (single-digit ms) and CI runs
  // several engines against one Postgres, where every extra connection per
  // instance is multiplied — see the note on `DB_POOL_MAX`.
  const authPoolMax = Number(process.env.DB_AUTH_POOL_MAX ?? 3);
  const authDb = new Kysely<DbSchema>({
    dialect: new BunSqlDialect({
      connectionString: withIdleInTransactionTimeout(process.env.DATABASE_URL ?? ''),
      max: authPoolMax,
    }),
  });
  const database = { db: authDb, type: 'postgres' as const };

  // Optional cache secondary storage for sessions
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  let secondaryStorage: any;
  if (process.env.VALKEY_URL) {
    const { createCacheSecondaryStorage } = await import('./runtime/index.js');
    secondaryStorage = await createCacheSecondaryStorage();
  }

  // Cookie security posture — pinned explicitly instead of relying on
  // better-auth's auto-detect on baseURL. Auto-detect treats `https://`
  // as production but mis-classifies tunnels (cloudflared, ngrok) and
  // anything served behind a reverse proxy that terminates TLS upstream
  // of the engine. Operators set NODE_ENV=production for live deploys;
  // CROSS_DOMAIN_AUTH=true switches SameSite to None for setups where
  // Studio and engine run on different origins.
  const inProd = process.env.NODE_ENV === 'production';
  const crossDomainAuth = process.env.CROSS_DOMAIN_AUTH === 'true';
  const advancedCookieConfig = {
    defaultCookieAttributes: {
      httpOnly: true,
      secure: inProd || crossDomainAuth,
      sameSite: crossDomainAuth ? ('none' as const) : ('lax' as const),
    },
  };

  // @ts-ignore — better-auth generics diverge between plugin overloads
  const authInstance = betterAuth({
    baseURL,
    trustedOrigins,
    secret: process.env.BETTER_AUTH_SECRET,
    database,

    // Hash single-use tokens at rest. Better-Auth 1.6 supports this and defaults
    // to plaintext (`processIdentifier`: `if (!option || option === "plain")
    // return identifier;`), so password-reset and e-mail-verification rows landed
    // in `verification.identifier` as `reset-password:<raw token>` — the token
    // itself, readable by anything that can read one table.
    //
    // That table is one of the unprefixed Better-Auth tables, which is exactly
    // the set two separate SQL guards failed to block (C-14, C-10) and which had
    // no RLS until migration 044. Those holes are closed; this is the layer that
    // decides how bad the next one is. With plaintext, one SELECT is every live
    // reset token on the instance and a full account takeover of anyone who
    // clicked "forgot password" in the last hour — including an admin. With the
    // rows hashed, the same SELECT yields digests that cannot be presented to
    // `/api/auth/reset-password`.
    //
    // `hashed` uses Better-Auth's own SHA-256 + base64url. That is the right
    // primitive here and not a password-hashing question: these tokens are
    // high-entropy random values with a one-hour life, so there is nothing to
    // brute-force and a slow KDF would only add latency to every verification.
    verification: { storeIdentifier: 'hashed' },
    advanced: advancedCookieConfig,
    ...(secondaryStorage ? { secondaryStorage } : {}),

    databaseHooks: {
      user: {
        create: {
          before: async (user: { email?: string }) => {
            if (authorizedUserCreation.getStore()) return { data: user };
            const { isRegistrationEnabled } = await import('../routes/settings.js');
            if (await isRegistrationEnabled(db)) return { data: user };
            console.warn(
              `[auth] refused to create an account for ${user.email ?? 'unknown'}: ` +
                `self-registration is disabled on this instance`,
            );
            throw new APIError('FORBIDDEN', {
              code: 'registration_disabled',
              message: 'Self-registration is disabled on this instance.',
            });
          },
        },
      },
    },

    emailAndPassword: {
      enabled: true,
      // Completing a password reset ends every existing session.
      //
      // Without this, the flow that exists BECAUSE an account may be
      // compromised leaves the attacker's session alive: the owner resets,
      // regains the ability to log in, and whoever was already signed in stays
      // signed in. Better-Auth deletes the user's sessions itself when this is
      // set — see `revokeSessionsOnPasswordReset` in its reset-password route.
      revokeSessionsOnPasswordReset: true,
      ...(process.env.SMTP_HOST
        ? {
            sendResetPassword: async ({
              user,
              url,
            }: {
              user: { email: string; name?: string };
              url: string;
            }) => {
              await sendEmail(
                user.email,
                'Reset your password',
                `<p>Hi ${user.name || user.email},</p><p>Click <a href="${url}">here</a> to reset your password. This link expires in 1 hour.</p>`,
                `Reset your password: ${url}`,
              );
            },
          }
        : {}),
      // Use argon2id via Bun.password (4 MB RAM) instead of better-auth's
      // default scrypt (32 MB RAM) so create-god and login work on small VMs.
      // Legacy scrypt hashes (salt:hexkey format) are verified transparently
      // so existing users are not locked out after upgrading. Successful
      // scrypt verifications trigger a silent re-hash to argon2id, so the
      // population of scrypt rows drains naturally as users sign in
      // (S4-09 migration). After PASSWORD_LEGACY_SCRYPT_DEADLINE has
      // passed, scrypt verification fails — by then nobody should be left.
      password: {
        hash: hashPassword,
        verify: verifyPassword,
      },
    },

    socialProviders: {
      ...(process.env.GOOGLE_CLIENT_ID
        ? {
            google: {
              clientId: process.env.GOOGLE_CLIENT_ID,
              clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
            },
          }
        : {}),
      ...(process.env.GITHUB_CLIENT_ID
        ? {
            github: {
              clientId: process.env.GITHUB_CLIENT_ID,
              clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
            },
          }
        : {}),
      ...(process.env.MICROSOFT_CLIENT_ID
        ? {
            microsoft: {
              clientId: process.env.MICROSOFT_CLIENT_ID,
              clientSecret: process.env.MICROSOFT_CLIENT_SECRET || '',
              tenantId: process.env.MICROSOFT_TENANT_ID || 'common',
            },
          }
        : {}),
      ...(process.env.DISCORD_CLIENT_ID
        ? {
            discord: {
              clientId: process.env.DISCORD_CLIENT_ID,
              clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
            },
          }
        : {}),
      ...(process.env.TWITTER_CLIENT_ID
        ? {
            twitter: {
              clientId: process.env.TWITTER_CLIENT_ID,
              clientSecret: process.env.TWITTER_CLIENT_SECRET || '',
            },
          }
        : {}),
      ...(process.env.APPLE_CLIENT_ID
        ? {
            apple: {
              clientId: process.env.APPLE_CLIENT_ID,
              clientSecret: process.env.APPLE_CLIENT_SECRET || '',
              teamId: process.env.APPLE_TEAM_ID || '',
              keyId: process.env.APPLE_KEY_ID || '',
              // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
            } as any,
          }
        : {}),
    },

    emailVerification: process.env.SMTP_HOST
      ? {
          sendVerificationEmail: async ({ user, url }) => {
            await sendEmail(
              user.email,
              'Verify your email',
              `<p>Hi ${user.name || user.email},</p><p>Click <a href="${url}">here</a> to verify your email address.</p><p>This link expires in 24 hours.</p>`,
              `Verify your email: ${url}`,
            );
          },
        }
      : undefined,

    plugins: [
      // TOTP 2FA — always enabled; users can opt in from their profile
      twoFactor({
        issuer: process.env.APP_NAME || 'Zveltio',
        totpOptions: { digits: 6, period: 30 },
        // Backup codes were stored in the clear. Better-Auth encrypts them only
        // when told to — `encodeBackupCodes` ends `return json` otherwise — and
        // this passed no options, so `twoFactor.backupCodes` held a plaintext
        // JSON array of ten `xxxxx-xxxxx` codes.
        //
        // The TOTP secret in the SAME ROW was already encrypted with
        // `BETTER_AUTH_SECRET`. That is the part that makes this worth fixing
        // rather than merely noting: a backup code is a complete second factor,
        // so encrypting the secret beside ten plaintext equivalents of it
        // protects nothing. Anything with a raw connection or a copy of a backup
        // had the second factor for every account that enabled 2FA.
        backupCodeOptions: { storeBackupCodes: 'encrypted' },
      }),

      // Magic link + password reset — enabled only when SMTP is configured
      ...(process.env.SMTP_HOST
        ? [
            magicLink({
              // Magic link signs people IN; it does not create accounts.
              //
              // Without this the plugin creates a user whenever the address is
              // unknown, which walked straight past the self-registration gate:
              // that gate is mounted on `/api/auth/sign-up/*`, and this is a
              // sign-in route. So on any instance with SMTP configured — and
              // with `registration_enabled` at its default of OFF — anyone could
              // type an unknown address, receive a link, and end up with an
              // account and a session.
              //
              // Operators who want open registration turn it on, and the sign-up
              // route provides it under the gate that exists for the purpose.
              disableSignUp: true,
              // Same reason as `verification` above: the plugin's own default is
              // `storeToken: "plain"`, which puts the literal magic-link token in
              // `verification.identifier`. A magic link is a bearer credential —
              // whoever reads the row can sign in as that person.
              storeToken: 'hashed',
              sendMagicLink: async ({ email, url }) => {
                await sendEmail(
                  email,
                  'Your sign-in link',
                  `<p>Click <a href="${url}">here</a> to sign in. This link expires in 10 minutes.</p>`,
                  `Sign in: ${url}`,
                );
              },
            }),
          ]
        : []),

      // WebAuthn / Passkeys — phishing-resistant credentials.
      // RP (relying party) settings: ID is the effective domain (must NOT
      // include scheme or port); origin is the full URL the browser will
      // see during ceremonies. For dev, both default to localhost. Set
      // BETTER_AUTH_URL / PASSKEY_RP_ID in production.
      passkey({
        rpID: process.env.PASSKEY_RP_ID || new URL(baseURL).hostname,
        rpName: process.env.APP_NAME || 'Zveltio',
        // Origin must match the page the user is authenticating from.
        // Most installations serve Studio + API on the same baseURL.
        origin: baseURL,
      }),
    ],
  });

  // Patch getSession to return null only for the expected "no/expired/
  // malformed cookie" cases that better-auth surfaces as APIError. A
  // database outage or programmer error should propagate so we see a
  // proper 500 instead of swallowing it into a silent 401. Without this
  // narrowing, every infrastructure failure looked like "logged out".
  const origGetSession = authInstance.api.getSession.bind(authInstance.api);
  // Outside the tenant transaction, always.
  //
  // Better Auth's tables are unreachable under `zveltio_rls`, which is what a
  // request runs as once `withTenantIsolation` opens. The refusal aborts the
  // transaction rather than merely failing the lookup, so one session read in the
  // wrong place takes the rest of the request with it. Wrapping here covers all
  // 55 engine and 99 extension call sites at once; wrapping at each of them would
  // be 154 chances to forget one.
  //
  // See `runWithoutTenantTrx` for the measurements, and for why granting the role
  // SELECT on `session` is not the fix even though it also makes them stop.
  const wrappedGetSession = wrapGetSession(origGetSession);
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  (authInstance.api as any).getSession = (...args: Parameters<typeof wrappedGetSession>) =>
    runWithoutTenantTrx(() => wrappedGetSession(...args));

  // @ts-ignore — specific Auth<Options> not assignable to Auth<BetterAuthOptions>
  _auth = authInstance;
  return _auth;
}

/** True when getSession should return null (bad/expired cookie) instead of re-throwing. */
export function isBenignGetSessionError(err: unknown): boolean {
  const e = err as { name?: string; status?: number; statusCode?: number };
  return (
    e?.name === 'APIError' ||
    e?.name === 'BetterAuthError' ||
    (typeof e?.status === 'number' && e.status >= 400 && e.status < 500) ||
    (typeof e?.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500)
  );
}

export function getAuth() {
  if (!_auth) throw new Error('Auth not initialized. Call initAuth() first.');
  return _auth;
}

/** Test-only export — never import outside src/tests/. */
export const _internalForTests = {
  resetSmtpCacheForTests() {
    _smtpTransport = null;
    _smtpFingerprint = '';
  },
  resetAuthModuleForTests() {
    _auth = null;
    _authDb = null;
    _smtpTransport = null;
    _smtpFingerprint = '';
  },
  setAuthDbForTests(db: Database | null) {
    _authDb = db;
  },
  sendEmailForTests: sendEmail,
  hashPassword,
  verifyPassword,
  isLegacyScryptDeadlinePassed,
  wrapGetSession,
};
