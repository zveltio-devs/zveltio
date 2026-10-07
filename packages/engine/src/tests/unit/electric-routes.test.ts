import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import { electricRoutes, _internalForTests } from '../../routes/electric.js';

/**
 * Electric routes. Electric's replication stream bypasses the engine's tenant,
 * row and column rules, so no token is minted on any instance:
 *   - 401 when the better-auth session is missing;
 *   - 503 when ELECTRIC_URL / ELECTRIC_AUTH_TOKEN are unset (SDK falls back);
 *   - 409 otherwise, with no token, URL or secret in the body.
 */

const fakeAuth = (user: { id: string } | null) => ({
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

function makeApp(user: { id: string } | null) {
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

// The stream Electric serves is not filtered by tenant, so nothing is minted or
// advertised while a second tenant exists. The harness test drives the real count.
describe('electric route — refused on every instance', () => {
  it('409 on mint and config, no token, no URL, no secret', async () => {
    process.env.ELECTRIC_URL = 'wss://e.test';
    process.env.ELECTRIC_AUTH_TOKEN = 'shared-secret';
    const app = makeApp({ id: 'u1' });
    for (const res of [
      await app.request('/api/electric/auth', { method: 'POST' }),
      await app.request('/api/electric/config'),
    ]) {
      expect(res.status).toBe(409);
      const text = await res.text();
      expect(text).not.toContain('token"');
      expect(text).not.toContain('e.test');
      expect(text).not.toContain('shared-secret');
    }
  });

  it('readConfig needs both variables', () => {
    process.env.ELECTRIC_URL = 'wss://e.test';
    delete process.env.ELECTRIC_AUTH_TOKEN;
    expect(_internalForTests.readConfig()).toBeNull();
  });
});
