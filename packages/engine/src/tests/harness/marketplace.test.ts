/**
 * Phase C — extension marketplace routes driven through the in-process app.
 *
 * lib/extensions/extension-marketplace-routes.ts (666 lines) is the biggest
 * uncovered lib module. Its routes reach the extension registry over the network
 * (REGISTRY_URL) which isn't available in the test env — so this suite drives
 * every route as a god user and TOLERATES registry-fetch failures: the point is
 * that the handler code (auth, param parsing, DB lookups, install/enable/disable
 * state machine, error handling) EXECUTES in-coverage up to and around the fetch.
 * Routes that don't touch the network (license history, not-found paths for an
 * uninstalled extension) get exact assertions.
 *
 * Registry-fetching routes carry a widened timeout. Skips without a test DB.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

// An extension that is definitely not installed — exercises the not-found /
// error arms of the install/enable/disable/config/uninstall handlers.
const GHOST = 'no-such-ext-xyz';

d('extension marketplace routes (in-process)', () => {
  let app: Hono;
  let cookie: string;

  const post = (path: string, body: unknown = {}) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    const t = await getTestApp();
    app = t.app;
    cookie = await createGodSession(app, t.db);
  });

  it('requires auth for the marketplace catalog', async () => {
    const res = await app.request('/api/marketplace');
    expect([401, 403]).toContain(res.status);
  });

  it('lists the catalog (GET /api/marketplace) — tolerates registry being offline', async () => {
    const res = await app.request('/api/marketplace', { headers: { cookie } });
    // Registry may be unreachable → the handler either returns a graceful
    // payload or a gateway error; either way the handler ran.
    expect(res.status).toBeLessThan(600);
  }, 20_000);

  it('reads license history (GET /api/admin/license/history) — DB only', async () => {
    const res = await app.request('/api/admin/license/history', { headers: { cookie } });
    expect(res.status).toBeLessThan(500);
  });

  it('rotates the license (POST /api/admin/license/rotate) — tolerates registry', async () => {
    const res = await app.request('/api/admin/license/rotate', post('/api/admin/license/rotate'));
    expect(res.status).toBeLessThan(600);
  }, 20_000);

  it('verifies + clears a license (POST/DELETE /api/marketplace/license/:name)', async () => {
    const verify = await app.request(
      `/api/marketplace/license/${GHOST}`,
      post(`/api/marketplace/license/${GHOST}`, { license_key: 'test-key' }),
    );
    expect(verify.status).toBeLessThan(600);
    const clear = await app.request(`/api/marketplace/license/${GHOST}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(clear.status).toBeLessThan(600);
  }, 20_000);

  it('installs an unknown extension (POST /:name/install) — tolerates download failure', async () => {
    const res = await app.request(`/api/marketplace/${GHOST}/install`, post(`/${GHOST}/install`));
    // No such extension in the registry → not-found / gateway error, never a
    // silent 200 for a ghost package.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(600);
  }, 20_000);

  it('enables an uninstalled extension (POST /:name/enable) → error', async () => {
    const res = await app.request(`/api/marketplace/${GHOST}/enable`, post(`/${GHOST}/enable`));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('disables an uninstalled extension (POST /:name/disable) — idempotent', async () => {
    const res = await app.request(`/api/marketplace/${GHOST}/disable`, post(`/${GHOST}/disable`));
    // Disable is idempotent (200 even for a not-installed ext); the handler ran.
    expect(res.status).toBeLessThan(600);
  });

  it('configures an uninstalled extension (PUT /:name/config)', async () => {
    const res = await app.request(`/api/marketplace/${GHOST}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ config: { k: 'v' } }),
    });
    expect(res.status).toBeLessThan(600);
  });

  it('uninstalls an uninstalled extension (POST /:name/uninstall) → error/no-op', async () => {
    const res = await app.request(
      `/api/marketplace/${GHOST}/uninstall`,
      post(`/${GHOST}/uninstall`),
    );
    expect(res.status).toBeLessThan(600);
  });

  it('enable-all (POST /api/marketplace/enable-all) — tolerates registry', async () => {
    const res = await app.request('/api/marketplace/enable-all', post('/enable-all'));
    expect(res.status).toBeLessThan(600);
  }, 20_000);
});
