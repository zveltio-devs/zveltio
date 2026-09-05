/**
 * What a demo instance must not let a visitor do.
 *
 * A demo is a public instance anyone can sign up to, so "admin-only" is not a
 * boundary there — the visitor can become an admin of their own tenant, and on
 * a single-tenant demo, of the instance. The list this middleware holds is
 * therefore the boundary.
 *
 * It had a shape worth noticing: DELETE on a user was blocked and PATCH was
 * not, so deleting an account was prevented while EDITING one — including its
 * role — was allowed, which is the more useful of the two to an attacker.
 * Backup RESTORE was blocked and taking a backup was not, so the whole database
 * could be read out in one file. Each rule was written for the destructive
 * verb and missed the useful one.
 */

import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { demoModeMiddleware } from '../../middleware/demo-mode.js';

/**
 * Run the middleware inside a real Hono app and report whether it refused.
 *
 * This used to hand the middleware a literal `{ req: { url, method } }`. That
 * object has no `req.path`, so the suite could only ever exercise the raw URL —
 * and the raw URL was the bug: the router matches on Hono's decoded path, the
 * gate matched on the undecoded one, and `POST /api/admin/%73ql` ran the SQL
 * editor while every case below stayed green. A stand-in context measured the
 * pattern list; it could not measure the gate.
 */
async function blocked(method: string, path: string): Promise<boolean> {
  process.env.DEMO_MODE = 'true';
  const app = new Hono();
  app.use('*', demoModeMiddleware());
  let reachedHandler = false;
  app.all('*', (c) => {
    reachedHandler = true;
    return c.text('ran');
  });
  const res = await app.request(`http://demo.zveltio.com${path}`, { method });
  delete process.env.DEMO_MODE;
  return !reachedHandler && res.status === 451;
}

describe('demo mode', () => {
  it('blocks taking a backup, not only restoring one', async () => {
    // A dump is the entire database in one file — every other visitor's demo
    // data, and whatever the operator seeded it from.
    expect(await blocked('POST', '/api/backup')).toBe(true);
    expect(await blocked('GET', '/api/backup/abc-123/download')).toBe(true);
    expect(await blocked('POST', '/api/backup/pitr/restore')).toBe(true);
  });

  it('blocks editing a user, not only deleting one', async () => {
    // PATCH carries `role`. Deleting an account is noisy and pointless;
    // promoting one is neither.
    expect(await blocked('PATCH', '/api/users/u-1')).toBe(true);
    expect(await blocked('DELETE', '/api/users/u-1')).toBe(true);
  });

  it('blocks the SQL editor', async () => {
    // The route refuses DROP DATABASE and DROP SCHEMA, which is a long way
    // from safe on an instance with open sign-up.
    expect(await blocked('POST', '/api/admin/sql')).toBe(true);
  });

  it('blocks API key creation and deletion', async () => {
    expect(await blocked('POST', '/api/admin/api-keys')).toBe(true);
    expect(await blocked('DELETE', '/api/admin/api-keys/k-1')).toBe(true);
  });

  it('leaves ordinary use alone', async () => {
    // The demo has to remain a demo: reading, and writing collection data,
    // are the point of it.
    expect(await blocked('GET', '/api/data/contacts')).toBe(false);
    expect(await blocked('POST', '/api/data/contacts')).toBe(false);
    expect(await blocked('GET', '/api/users/u-1')).toBe(false);
    expect(await blocked('GET', '/api/backup')).toBe(false);
  });

  it('blocks the same routes reached through a percent-encoded segment', async () => {
    // Hono decodes each segment once before routing, so all of these reach
    // exactly the handler their plain spelling reaches. The gate has to be
    // looking at the same string the router looked at, or one escaped letter
    // walks past every rule in the list.
    expect(await blocked('POST', '/api/admin/%73ql')).toBe(true);
    expect(await blocked('POST', '/api/%61dmin/sql')).toBe(true);
    expect(await blocked('POST', '/api/b%61ckup')).toBe(true);
    expect(await blocked('GET', '/api/backup/abc-123/%64ownload')).toBe(true);
    expect(await blocked('PATCH', '/api/%75sers/u-1')).toBe(true);
  });

  it('does nothing at all when demo mode is off', async () => {
    delete process.env.DEMO_MODE;
    const app = new Hono();
    app.use('*', demoModeMiddleware());
    let reached = false;
    app.all('*', (c) => {
      reached = true;
      return c.text('ran');
    });
    await app.request('http://x/api/backup', { method: 'POST' });
    expect(reached).toBe(true);
  });
});
