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
 *
 * Refused, on every instance. Electric streams a published table through
 * logical replication: none of the engine's read gates run on that stream —
 * not the tenant (the `tenant_id` claim is not read by Electric), not row
 * rules, not column permissions. One tenant does not make that safe: a member
 * would still receive the rows and columns their rules hide. No token is minted
 * until shapes are served through an engine-controlled filter.
 */

import { Hono } from 'hono';
import { guardSession } from '../lib/admin-guard.js';
import type { Database } from '../db/index.js';
import { problem } from '../lib/problem.js';

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

export function electricRoutes(
  db: Database,
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  auth: any,
): Hono {
  const app = new Hono();

  /** Throws a 409 problem: the stream is not filtered by the engine's rules. */
  function refuseUnfiltered(): never {
    throw problem(
      'electric.unfiltered',
      409,
      "Electric is disabled: its replication stream bypasses the engine's tenant, row and " +
        'column rules. Use provider: "crdt".',
    );
  }

  // Session guard for every route — Electric tokens are scoped per user.
  app.use('*', async (c, next) => {
    const session = await guardSession(c, auth);
    if (session instanceof Response) return session;
    c.set('user', session.user);
    await next();
  });

  // 503 with the old shape when Electric is not configured (the SDK reads it to
  // fall back to CRDT); otherwise refused — see the header. No URL, no token.
  app.get('/config', (c) => {
    if (!readConfig()) {
      return c.json(
        {
          enabled: false,
          reason: 'ELECTRIC_URL and ELECTRIC_AUTH_TOKEN must both be set on the engine',
        },
        503,
      );
    }
    return refuseUnfiltered();
  });
  app.post('/auth', (c) => {
    if (!readConfig()) {
      return c.json(
        {
          error:
            'Electric is not configured on this engine. Use provider: "crdt" or ' +
            'set ELECTRIC_URL + ELECTRIC_AUTH_TOKEN.',
        },
        503,
      );
    }
    return refuseUnfiltered();
  });

  return app;
}

// Internal exports for tests — never imported outside the test suite.
export const _internalForTests = { readConfig };
