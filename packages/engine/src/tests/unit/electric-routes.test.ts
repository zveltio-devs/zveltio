import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import { electricRoutes, _internalForTests } from '../../routes/electric.js';

/**
 * S5-07 — Electric token mint route.
 *
 * The route is small but security-critical: a leaked token grants the
 * holder Electric-side access for 60 seconds. The tests verify:
 *   - 503 when ELECTRIC_URL / ELECTRIC_AUTH_TOKEN are unset.
 *   - 401 when the better-auth session is missing.
 *   - Successful mint returns a valid HS256 JWT with the right claims.
 *   - The shared secret never appears in any response body.
 */

const fakeAuth = (user: { id: string; tenantId?: string } | null) => ({
  api: {
    async getSession() {
      return user ? { user } : null;
    },
  },
});

let prevUrl: string | undefined;
let prevToken: string | undefined;

beforeEach(() => {
  prevUrl = process.env.ELECTRIC_URL;
  prevToken = process.env.ELECTRIC_AUTH_TOKEN;
});

afterEach(() => {
  if (prevUrl === undefined) delete process.env.ELECTRIC_URL;
  else process.env.ELECTRIC_URL = prevUrl;
  if (prevToken === undefined) delete process.env.ELECTRIC_AUTH_TOKEN;
  else process.env.ELECTRIC_AUTH_TOKEN = prevToken;
});

function makeApp(user: { id: string; tenantId?: string } | null) {
  const app = new Hono();
  app.route('/api/electric', electricRoutes({} as never, fakeAuth(user)));
  return app;
}

describe('S5-07 electric route — auth gate', () => {
  it('401 when no session', async () => {
    process.env.ELECTRIC_URL = 'wss://e.test';
    process.env.ELECTRIC_AUTH_TOKEN = 's';
    const app = makeApp(null);
    const res = await app.request('/api/electric/auth', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

describe('S5-07 electric route — service-unavailable', () => {
  it('503 when ELECTRIC_URL is unset', async () => {
    delete process.env.ELECTRIC_URL;
    delete process.env.ELECTRIC_AUTH_TOKEN;
    const app = makeApp({ id: 'u1' });
    const res = await app.request('/api/electric/auth', { method: 'POST' });
    expect(res.status).toBe(503);
  });

  it('config endpoint returns enabled:false when unset', async () => {
    delete process.env.ELECTRIC_URL;
    const app = makeApp({ id: 'u1' });
    const res = await app.request('/api/electric/config');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { enabled: boolean };
    expect(body.enabled).toBe(false);
  });
});

describe('S5-07 electric route — token mint', () => {
  it('mints a HS256 JWT with sub + exp + aud claims', async () => {
    process.env.ELECTRIC_URL = 'wss://electric.test';
    process.env.ELECTRIC_AUTH_TOKEN = 'shared-secret';
    const app = makeApp({ id: 'user-42', tenantId: 'tenant-7' });

    const res = await app.request('/api/electric/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tables: ['zvd_contacts'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresAt: number; electricUrl: string };

    // Three segments separated by dots.
    expect(body.token.split('.').length).toBe(3);

    // Decode + check claims.
    const [, payloadB64] = body.token.split('.');
    const padded =
      payloadB64.replace(/-/g, '+').replace(/_/g, '/') +
      '='.repeat((4 - (payloadB64.length % 4)) % 4);
    const claims = JSON.parse(atob(padded)) as Record<string, unknown>;
    expect(claims.sub).toBe('user-42');
    expect(claims.tenant_id).toBe('tenant-7');
    expect(claims.aud).toBe('electric-sql');
    expect(claims.tables).toEqual(['zvd_contacts']);
    expect(typeof claims.exp).toBe('number');
    expect(typeof claims.iat).toBe('number');
    expect(claims.exp as number).toBeGreaterThan(claims.iat as number);

    // Public response includes the Electric URL but NEVER the secret.
    expect(body.electricUrl).toBe('wss://electric.test');
    expect(JSON.stringify(body)).not.toContain('shared-secret');
  });

  it('signHs256 produces a deterministic signature for fixed inputs', async () => {
    const t1 = await _internalForTests.signHs256({ a: 1 }, 'secret');
    const t2 = await _internalForTests.signHs256({ a: 1 }, 'secret');
    expect(t1).toBe(t2);
    const t3 = await _internalForTests.signHs256({ a: 1 }, 'different');
    expect(t3).not.toBe(t1);
  });
});
