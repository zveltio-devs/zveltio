import { betterAuth } from 'better-auth';
// @ts-ignore — better-auth/adapters/kysely types may not resolve in all TS modes
import { kyselyAdapter } from 'better-auth/adapters/kysely';
import { twoFactor } from 'better-auth/plugins';
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
    database: kyselyAdapter(db as any),
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

    plugins: [
      twoFactor({
        issuer: 'Zveltio',
        totpWindow: 1,
      }),
    ],
  });

  return _auth;
}

export function getAuth() {
  if (!_auth) throw new Error('Auth not initialized. Call initAuth() first.');
  return _auth;
}
