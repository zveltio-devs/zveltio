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

  // Use pg.Pool for better-auth — pg is a transitive dependency and better-auth
  // natively supports it via @better-auth/kysely-adapter's PostgresDialect path.
  // This avoids compatibility issues between BunSqlDialect and the Kysely adapter.
  const { Pool } = await import('pg');
  const pgPool = new Pool({ connectionString: databaseUrl, max: 5 });

  // Optional cache secondary storage for sessions
  let secondaryStorage: any = undefined;
  if (process.env.VALKEY_URL) {
    const { createCacheSecondaryStorage } = await import('./cache.js');
    secondaryStorage = await createCacheSecondaryStorage();
  }

  // @ts-ignore — better-auth generics diverge between plugin overloads
  _auth = betterAuth({
    baseURL,
    secret: process.env.BETTER_AUTH_SECRET,
    // Pass pg.Pool directly — better-auth detects it via "connect" method
    // and wraps it in PostgresDialect internally
    database: pgPool as any,
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

  return _auth;
}

export function getAuth() {
  if (!_auth) throw new Error('Auth not initialized. Call initAuth() first.');
  return _auth;
}
