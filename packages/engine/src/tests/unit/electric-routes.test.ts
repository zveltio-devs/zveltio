import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { electricRoutes, _internalForTests } from '../../routes/electric.js';

/**
 * The Electric shape route's door. What it does with a signed-in caller — the
 * shape it builds, the params it refuses, the 503 — needs a database and is in
 * tests/harness/electric-shapes.test.ts.
 */

const saved = { url: process.env.ELECTRIC_URL, secret: process.env.ELECTRIC_SECRET };

beforeEach(() => {
  process.env.ELECTRIC_URL = 'http://electric.test:3000';
  process.env.ELECTRIC_SECRET = 'shared-secret';
});

afterEach(() => {
  for (const [k, v] of [
    ['ELECTRIC_URL', saved.url],
    ['ELECTRIC_SECRET', saved.secret],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('electric shape route', () => {
  it('401 with no session and no key, before anything is read', async () => {
    const app = new Hono();
    const auth = { api: { getSession: async () => null } };
    app.route('/api/electric', electricRoutes({} as never, auth));
    const res = await app.request('/api/electric/v1/shape?collection=notes&offset=-1');
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('shared-secret');
  });

  it('readConfig needs both variables and drops a trailing slash', () => {
    expect(_internalForTests.readConfig()).toEqual({
      electricUrl: 'http://electric.test:3000',
      secret: 'shared-secret',
    });
    process.env.ELECTRIC_URL = 'http://electric.test:3000/';
    expect(_internalForTests.readConfig()?.electricUrl).toBe('http://electric.test:3000');
    delete process.env.ELECTRIC_SECRET;
    expect(_internalForTests.readConfig()).toBeNull();
  });
});
