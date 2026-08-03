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
import { demoModeMiddleware } from '../../middleware/demo-mode.js';

/** Run the middleware over a request and report whether it was refused. */
async function blocked(method: string, path: string): Promise<boolean> {
  process.env.DEMO_MODE = 'true';
  const mw = demoModeMiddleware();
  let reachedHandler = false;
  const c = {
    req: { url: `http://demo.zveltio.com${path}`, method },
    json: (body: unknown, status?: number) => ({ body, status }),
    // biome-ignore lint/suspicious/noExplicitAny: minimal Hono context stand-in
  } as any;
  const res = await mw(c, async () => {
    reachedHandler = true;
  });
  delete process.env.DEMO_MODE;
  return !reachedHandler && res !== undefined;
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

  it('does nothing at all when demo mode is off', async () => {
    delete process.env.DEMO_MODE;
    const mw = demoModeMiddleware();
    let reached = false;
    // biome-ignore lint/suspicious/noExplicitAny: minimal Hono context stand-in
    const c = { req: { url: 'http://x/api/backup', method: 'POST' } } as any;
    await mw(c, async () => {
      reached = true;
    });
    expect(reached).toBe(true);
  });
});
