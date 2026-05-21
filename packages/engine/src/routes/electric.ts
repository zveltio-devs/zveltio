/**
 * Electric SQL bridge — token mint + service config.
 *
 * Electric SQL streams Postgres changes to clients over a websocket. The
 * client authenticates to Electric with a short-lived JWT signed by a
 * shared secret. The engine knows the user (better-auth session) and the
 * shared secret (`ELECTRIC_AUTH_TOKEN`); the client knows neither.
 *
 * Flow:
 *
 *   1. Client → engine `POST /api/electric/auth` (with session cookie)
 *      → engine validates session, mints HS256 JWT { sub, tenant_id, exp }
 *      → returns { token, expiresAt, electricUrl }.
 *
 *   2. Client → Electric `wss://electric/...?token=<jwt>` directly.
 *      Electric verifies the JWT signature with the same shared secret.
 *
 * Why this design (vs. proxying through engine):
 *   - Electric is built for direct websocket sync; proxying defeats its
 *     low-latency replication model.
 *   - The shared HS256 secret lives only in two trusted environments
 *     (engine + Electric service), never on the client.
 *   - Token expiry (default 60s) is short enough that revocation isn't
 *     needed — the client requests a fresh one before each session.
 *
 * Required env:
 *   - `ELECTRIC_URL`        e.g. `wss://electric.internal:5133`
 *   - `ELECTRIC_AUTH_TOKEN` shared HS256 secret with the Electric service
 *
 * When unset, the routes return 503 — callers fall back to the CRDT
 * provider (which is the default anyway).
 */

import { Hono } from 'hono';
import type { Database } from '../db/index.js';

const TOKEN_TTL_SECONDS = 60;

/** Base64url without padding — matches the JWT spec. */
function b64url(input: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof input === 'string') bytes = new TextEncoder().encode(input);
  else if (input instanceof Uint8Array) bytes = input;
  else bytes = new Uint8Array(input);
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function signHs256(payload: object, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
}

interface ElectricConfig {
  electricUrl: string;
  authToken: string;
}

function readConfig(): ElectricConfig | null {
  const electricUrl = process.env.ELECTRIC_URL?.trim();
  const authToken = process.env.ELECTRIC_AUTH_TOKEN?.trim();
  if (!electricUrl || !authToken) return null;
  return { electricUrl, authToken };
}

export function electricRoutes(_db: Database, auth: any): Hono {
  const app = new Hono();

  // Session guard for every route — Electric tokens are scoped per user.
  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', session.user);
    await next();
  });

  // GET /api/electric/config — surface the websocket URL the client should
  // connect to + whether Electric is enabled for this engine deployment.
  // Hides the shared secret unconditionally.
  app.get('/config', (c) => {
    const cfg = readConfig();
    if (!cfg) {
      return c.json({
        enabled: false,
        reason: 'ELECTRIC_URL and ELECTRIC_AUTH_TOKEN must both be set on the engine',
      }, 503);
    }
    return c.json({
      enabled: true,
      electricUrl: cfg.electricUrl,
      tokenTtlSeconds: TOKEN_TTL_SECONDS,
    });
  });

  // POST /api/electric/auth — mint a short-lived HS256 JWT the client
  // hands to Electric to open its replication stream. Body is optional;
  // when present it may carry { tables: string[] } to record an audit
  // claim of which tables the client intends to sync (Electric itself
  // enforces table access via its own config, not via the JWT — this is
  // purely an audit hint we may consult later for usage analytics).
  app.post('/auth', async (c) => {
    const cfg = readConfig();
    if (!cfg) {
      return c.json({
        error: 'Electric is not configured on this engine. Use provider: "crdt" or ' +
               'set ELECTRIC_URL + ELECTRIC_AUTH_TOKEN.',
      }, 503);
    }

    const user = c.get('user') as { id: string; tenantId?: string };
    const body = await c.req.json().catch(() => null) as { tables?: unknown } | null;
    const tables = Array.isArray(body?.tables)
      ? (body!.tables as unknown[]).filter((t): t is string => typeof t === 'string')
      : undefined;

    const now = Math.floor(Date.now() / 1000);
    const exp = now + TOKEN_TTL_SECONDS;
    const claims: Record<string, unknown> = {
      sub: user.id,
      iat: now,
      exp,
      iss: 'zveltio-engine',
      aud: 'electric-sql',
    };
    if (user.tenantId) claims.tenant_id = user.tenantId;
    if (tables && tables.length > 0) claims.tables = tables;

    const token = await signHs256(claims, cfg.authToken);
    return c.json({
      token,
      expiresAt: exp * 1000, // ms epoch — easier for client schedulers
      electricUrl: cfg.electricUrl,
    });
  });

  return app;
}

// Internal exports for tests — never imported outside the test suite.
export const _internalForTests = { signHs256, readConfig };
