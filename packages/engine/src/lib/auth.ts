import { betterAuth } from 'better-auth';
import type { Database } from '../db/index.js';

let _auth: ReturnType<typeof betterAuth> | null = null;

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

  const port = process.env.PORT || '3000';
  const baseURL = process.env.BETTER_AUTH_URL || `http://localhost:${port}`;

  // Trusted origins: since studio and client are served by THIS engine (same origin),
  // we need to trust requests from any IP/hostname the server might be accessed via.
  // Detect all local network interfaces and add them as trusted origins.
  const localOrigins: string[] = [baseURL, `http://localhost:${port}`, `https://localhost:${port}`];
  try {
    const { networkInterfaces } = await import('os');
    for (const ifaces of Object.values(networkInterfaces())) {
      for (const iface of (ifaces || [])) {
        if (iface.family === 'IPv4' && !iface.internal) {
          localOrigins.push(`http://${iface.address}:${port}`);
          localOrigins.push(`https://${iface.address}:${port}`);
        }
      }
    }
  } catch { /* non-fatal */ }

  const trustedOrigins = [
    ...new Set([
      ...localOrigins,
      ...(process.env.CORS_ORIGINS
        ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
        : []),
    ]),
  ];

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
  const database: any = { db, type: 'postgres' };

  // Optional cache secondary storage for sessions
  let secondaryStorage: any = undefined;
  if (process.env.VALKEY_URL) {
    const { createCacheSecondaryStorage } = await import('./cache.js');
    secondaryStorage = await createCacheSecondaryStorage();
  }

  // @ts-ignore — better-auth generics diverge between plugin overloads
  const authInstance = betterAuth({
    baseURL,
    trustedOrigins,
    secret: process.env.BETTER_AUTH_SECRET,
    database,
    ...(secondaryStorage ? { secondaryStorage } : {}),

    emailAndPassword: {
      enabled: true,
      // Use argon2id via Bun.password (4 MB RAM) instead of better-auth's
      // default scrypt (32 MB RAM) so create-god and login work on small VMs.
      // Legacy scrypt hashes (salt:hexkey format) are verified transparently
      // so existing users are not locked out after upgrading.
      password: {
        hash: (password: string) =>
          Bun.password.hash(password, { algorithm: 'argon2id', memoryCost: 4096, timeCost: 3 }),
        verify: async ({ hash, password }: { hash: string; password: string }) => {
          // New hashes: argon2id / bcrypt — start with '$'
          if (hash.startsWith('$')) {
            return Bun.password.verify(password, hash);
          }
          // Legacy hashes: better-auth default scrypt format "salt:hexkey"
          const [salt, key] = hash.split(':');
          if (!salt || !key) return false;
          try {
            const { scryptSync } = await import('crypto');
            const derived = scryptSync(password, salt, 64, { N: 16384, r: 16, p: 1 });
            return derived.toString('hex') === key;
          } catch {
            return false;
          }
        },
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
    },

    plugins: [],
  });

  // Patch getSession to return null instead of throwing — better-auth v1.5+
  // can throw APIError when a malformed/expired cookie is sent, causing routes
  // that use requireAdmin() to return 500 instead of 401.
  const origGetSession = authInstance.api.getSession.bind(authInstance.api);
  (authInstance.api as any).getSession = async (...args: any[]) => {
    try {
      return await origGetSession(...args as [any]);
    } catch (err) {
      // Log the error so we can diagnose session failures — do NOT swallow silently.
      console.error('[getSession] Error (returning null):', err instanceof Error ? err.message : err);
      return null;
    }
  };

  // @ts-ignore — specific Auth<Options> not assignable to Auth<BetterAuthOptions>
  _auth = authInstance;
  return _auth;
}

export function getAuth() {
  if (!_auth) throw new Error('Auth not initialized. Call initAuth() first.');
  return _auth;
}
