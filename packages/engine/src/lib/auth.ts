import { betterAuth } from 'better-auth';
import { twoFactor } from 'better-auth/plugins';
import { magicLink } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import type { Database } from '../db/index.js';

let _auth: ReturnType<typeof betterAuth> | null = null;

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
      console.warn(
        '[auth] Re-hash to argon2id failed (will retry on next login):',
        err.message,
      );
    });
    return true;
  } catch {
    return false;
  }
}

/** Patched getSession wrapper — exported for unit tests. */
// biome-ignore lint/suspicious/noExplicitAny: test seam mirrors production patch
export function wrapGetSession<T extends (...args: any[]) => Promise<any>>(orig: T): T {
  // biome-ignore lint/suspicious/noExplicitAny: mirrors production getSession patch arity
  return (async (...args: any[]) => {
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
export async function countLegacyScryptHashes(db: Database): Promise<number> {
  try {
    const rows = await db
      .selectFrom('account')
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      .select((eb: any) => eb.fn.count('id').as('count'))
      .where('password', 'is not', null)
      // SQL pattern: anything that DOES NOT start with `$`.
      .where('password', 'not like', '$%')
      .executeTakeFirst();
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  const database: any = { db, type: 'postgres' };

  // Optional cache secondary storage for sessions
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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
    advanced: advancedCookieConfig,
    ...(secondaryStorage ? { secondaryStorage } : {}),

    emailAndPassword: {
      enabled: true,
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
              // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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
      }),

      // Magic link + password reset — enabled only when SMTP is configured
      ...(process.env.SMTP_HOST
        ? [
            magicLink({
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
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  (authInstance.api as any).getSession = wrapGetSession(origGetSession);

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
