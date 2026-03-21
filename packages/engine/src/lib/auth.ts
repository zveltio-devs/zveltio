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

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required for auth');
  }

  const port = process.env.PORT || '3000';
  const baseURL = process.env.BETTER_AUTH_URL || `http://localhost:${port}`;

  // Build a standard Kysely+PostgresDialect instance for better-auth.
  // Using pg.Pool directly (as `database: pgPool as any`) skips the Kysely
  // adapter entirely: better-auth falls back to its raw-pg path which does NOT
  // double-quote camelCase column names ("emailVerified", "createdAt", etc.).
  // PostgreSQL then lowercases unquoted identifiers → column-not-found errors.
  // Wrapping via kyselyAdapter(kyselyInstance) ensures Kysely compiles all
  // queries with properly-quoted identifiers that match our 001_auth.sql schema.
  const { Pool } = await import('pg');
  const { Kysely, PostgresDialect } = await import('kysely');
  const { kyselyAdapter } = await import('@better-auth/kysely-adapter');
  const pgPool = new Pool({ connectionString: databaseUrl, max: 5 });
  const kyselyForBetterAuth = new Kysely({ dialect: new PostgresDialect({ pool: pgPool }) });

  // Optional cache secondary storage for sessions
  let secondaryStorage: any = undefined;
  if (process.env.VALKEY_URL) {
    const { createCacheSecondaryStorage } = await import('./cache.js');
    secondaryStorage = await createCacheSecondaryStorage();
  }

  // @ts-ignore — better-auth generics diverge between plugin overloads
  const authInstance = betterAuth({
    baseURL,
    secret: process.env.BETTER_AUTH_SECRET,
    database: kyselyAdapter(kyselyForBetterAuth, { type: 'postgres' }),
    ...(secondaryStorage ? { secondaryStorage } : {}),

    emailAndPassword: { enabled: true },

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
    } catch {
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
