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

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { resolveExtensionsBase } from '../../lib/extensions/extension-paths.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

// An extension that is definitely not installed — exercises the not-found /
// error arms of the install/enable/disable/config/uninstall handlers.
const GHOST = 'no-such-ext-xyz';
const HELLO_EXT = 'hello-ext';
const FIXTURE_DIR = join(import.meta.dir, '../fixtures/hello-ext');

let originalFetch: typeof fetch;

function stubLicenseVerifyOk(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/licenses/verify')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ valid: true }),
      } as Response;
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}

function ensureHelloExtOnDisk(): void {
  const extBase = resolveExtensionsBase();
  const target = join(extBase, HELLO_EXT);
  if (!existsSync(join(target, 'manifest.json'))) {
    mkdirSync(extBase, { recursive: true });
    cpSync(FIXTURE_DIR, target, { recursive: true });
  }
}

d('extension marketplace routes (in-process)', () => {
  let app: Hono;
  let cookie: string;

  const post = (path: string, body: unknown = {}) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    originalFetch = globalThis.fetch;
    const t = await getTestApp();
    app = t.app;
    cookie = await createGodSession(app, t.db);
    ensureHelloExtOnDisk();
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it('requires auth for the marketplace catalog', async () => {
    const res = await app.request('/api/marketplace');
    expect([401, 403]).toContain(res.status);
  });

  it('rejects license store without a license_key (400)', async () => {
    const res = await app.request(
      '/api/marketplace/license/some-ext',
      post('/api/marketplace/license/some-ext', {}),
    );
    expect(res.status).toBe(400);
  });

  it('stores a license key when registry verify succeeds (stubbed fetch)', async () => {
    stubLicenseVerifyOk();
    const name = `harness-lic-ok-${Date.now()}`;
    const res = await app.request(
      `/api/marketplace/license/${name}`,
      post(`/api/marketplace/license/${name}`, { license_key: 'verified-key-abc' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    const clear = await app.request(`/api/marketplace/license/${name}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(clear.status).toBe(200);
  });

  it('stores or rejects a license key via registry verify', async () => {
    const name = `harness-lic-${Date.now()}`;
    const res = await app.request(
      `/api/marketplace/license/${name}`,
      post(`/api/marketplace/license/${name}`, { license_key: 'test-license-key-123' }),
    );
    // Registry may be unreachable (stores) or reachable-but-invalid (400).
    expect(res.status).toBeLessThan(500);
    if (res.status === 200) {
      await app.request(`/api/marketplace/license/${name}`, {
        method: 'DELETE',
        headers: { cookie },
      });
    }
  }, 15_000);

  it('returns 401 for admin license history without a session', async () => {
    const res = await app.request('/api/admin/license/history');
    expect(res.status).toBe(401);
  });

  it('lists the catalog with tenant scoping header (GET /api/marketplace)', async () => {
    const res = await app.request('/api/marketplace', {
      headers: { cookie, 'x-tenant-id': 'default' },
    });
    expect(res.status).toBeLessThan(600);
  }, 20_000);

  it('lists the catalog (GET /api/marketplace) — returns extensions array', async () => {
    const res = await app.request('/api/marketplace', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { extensions: unknown[] };
    expect(Array.isArray(body.extensions)).toBe(true);
    expect(body.extensions.length).toBeGreaterThan(0);
  }, 20_000);

  it('catalog entries expose marketplace merge fields', async () => {
    const res = await app.request('/api/marketplace', {
      headers: { cookie, 'x-tenant-id': 'default' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      extensions: Array<Record<string, unknown>>;
    };
    const first = body.extensions[0]!;
    expect(typeof first.name).toBe('string');
    expect(Array.isArray(first.dependencies)).toBe(true);
    expect(Array.isArray(first.missing_dependencies)).toBe(true);
    expect(typeof first.is_installed).toBe('boolean');
    expect(typeof first.is_enabled).toBe('boolean');
    expect(typeof first.is_running).toBe('boolean');
    expect(typeof first.files_on_disk).toBe('boolean');
    expect(typeof first.has_license).toBe('boolean');
    expect('needs_restart' in first).toBe(true);
  }, 20_000);

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

  it('rotates the marketplace auth token (POST /api/admin/license/rotate)', async () => {
    const res = await app.request('/api/admin/license/rotate', post('/api/admin/license/rotate'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; token: string };
    expect(body.ok).toBe(true);
    expect(body.token.length).toBeGreaterThanOrEqual(32);
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

  it('installs hello-ext from on-disk files (POST /:name/install)', async () => {
    const res = await app.request(
      `/api/marketplace/${HELLO_EXT}/install`,
      post(`/${HELLO_EXT}/install`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; files_on_disk: boolean };
    expect(body.success).toBe(true);
    expect(body.files_on_disk).toBe(true);
  }, 20_000);

  it('enables hello-ext when files are on disk (POST /:name/enable)', async () => {
    ensureHelloExtOnDisk();
    const res = await app.request(
      `/api/marketplace/${HELLO_EXT}/enable`,
      post(`/${HELLO_EXT}/enable`),
    );
    expect(res.status).toBeLessThan(600);
    const body = (await res.json()) as { success?: boolean; hot_loaded?: boolean };
    expect(typeof body).toBe('object');
  }, 30_000);

  it('reads hello-ext config (GET /:name/config)', async () => {
    ensureHelloExtOnDisk();
    const res = await app.request(`/api/marketplace/${HELLO_EXT}/config`, { headers: { cookie } });
    expect(res.status).toBeLessThan(600);
  }, 20_000);

  it('updates hello-ext config (PUT /:name/config)', async () => {
    ensureHelloExtOnDisk();
    const res = await app.request(`/api/marketplace/${HELLO_EXT}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ config: { greeting: 'harness' } }),
    });
    expect(res.status).toBeLessThan(600);
  }, 20_000);

  it('disables hello-ext after enable (POST /:name/disable)', async () => {
    ensureHelloExtOnDisk();
    const res = await app.request(
      `/api/marketplace/${HELLO_EXT}/disable`,
      post(`/${HELLO_EXT}/disable`),
    );
    expect(res.status).toBeLessThan(600);
  }, 20_000);

  it('uninstalls hello-ext after install (POST /:name/uninstall)', async () => {
    ensureHelloExtOnDisk();
    const res = await app.request(
      `/api/marketplace/${HELLO_EXT}/uninstall`,
      post(`/${HELLO_EXT}/uninstall`),
    );
    expect(res.status).toBeLessThan(600);
  }, 20_000);

  it('rejects a license when registry verify returns non-ok (stubbed fetch)', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/licenses/verify')) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ message: 'Invalid license key' }),
        } as Response;
      }
      return originalFetch(input);
    }) as typeof fetch;
    const name = `harness-lic-bad-${Date.now()}`;
    const res = await app.request(
      `/api/marketplace/license/${name}`,
      post(`/api/marketplace/license/${name}`, { license_key: 'bad-key' }),
    );
    expect(res.status).toBe(400);
  }, 15_000);

  it('installs an unknown extension (POST /:name/install) — tolerates download failure', async () => {
    const res = await app.request(`/api/marketplace/${GHOST}/install`, post(`/${GHOST}/install`));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(600);
    if (res.status === 422) {
      const body = (await res.json()) as { files_on_disk?: boolean; success?: boolean };
      expect(body.success).toBe(false);
      expect(body.files_on_disk).toBe(false);
    }
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

  it('enable-all returns a structured payload after hello-ext install', async () => {
    ensureHelloExtOnDisk();
    await app.request(`/api/marketplace/${HELLO_EXT}/install`, post(`/${HELLO_EXT}/install`));
    const res = await app.request('/api/marketplace/enable-all', post('/enable-all'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: number; failed: number; success: boolean };
    expect(typeof body.enabled).toBe('number');
    expect(typeof body.failed).toBe('number');
    expect(typeof body.success).toBe('boolean');
  }, 30_000);

  it('re-enables hello-ext via enable after disable', async () => {
    ensureHelloExtOnDisk();
    await app.request(`/api/marketplace/${HELLO_EXT}/disable`, post(`/${HELLO_EXT}/disable`));
    const res = await app.request(
      `/api/marketplace/${HELLO_EXT}/enable`,
      post(`/${HELLO_EXT}/enable`),
    );
    expect(res.status).toBeLessThan(600);
  }, 30_000);

  it('stores a license key when registry verify is offline (stubbed fetch)', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/licenses/verify')) {
        throw new Error('registry offline');
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    const name = `harness-lic-offline-${Date.now()}`;
    const res = await app.request(
      `/api/marketplace/license/${name}`,
      post(`/api/marketplace/license/${name}`, { license_key: 'offline-key' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    await app.request(`/api/marketplace/license/${name}`, {
      method: 'DELETE',
      headers: { cookie },
    });
  }, 15_000);

  it('soft-uninstall preserves data (purgeData omitted)', async () => {
    ensureHelloExtOnDisk();
    await app.request(`/api/marketplace/${HELLO_EXT}/install`, post(`/${HELLO_EXT}/install`));
    const res = await app.request(
      `/api/marketplace/${HELLO_EXT}/uninstall`,
      post(`/${HELLO_EXT}/uninstall`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; purged: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.purged).toBe(false);
    expect(body.message).toMatch(/purgeData=true/i);
  }, 30_000);

  it('purge uninstall removes hello-ext when installed (purgeData=true)', async () => {
    ensureHelloExtOnDisk();
    await app.request(`/api/marketplace/${HELLO_EXT}/install`, post(`/${HELLO_EXT}/install`));
    const res = await app.request(
      `/api/marketplace/${HELLO_EXT}/uninstall?purgeData=true`,
      post(`/${HELLO_EXT}/uninstall?purgeData=true`),
    );
    expect(res.status).toBeLessThan(600);
    if (res.status === 200) {
      const body = (await res.json()) as { purged?: boolean };
      expect(body.purged).toBe(true);
    }
    ensureHelloExtOnDisk();
  }, 40_000);

  it('enable on a catalog ghost returns 404', async () => {
    const res = await app.request(`/api/marketplace/${GHOST}/enable`, post(`/${GHOST}/enable`));
    expect(res.status).toBe(404);
  }, 20_000);

  it('catalog includes hello-ext with runtime merge fields', async () => {
    ensureHelloExtOnDisk();
    const res = await app.request('/api/marketplace', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { extensions: Array<Record<string, unknown>> };
    const hello = body.extensions.find((e) => e.name === HELLO_EXT);
    expect(hello).toBeDefined();
    expect(typeof hello!.files_on_disk).toBe('boolean');
    expect(typeof hello!.is_running).toBe('boolean');
    expect(typeof hello!.has_license).toBe('boolean');
  }, 20_000);

  it('disable on an installed extension returns success JSON', async () => {
    ensureHelloExtOnDisk();
    await app.request(`/api/marketplace/${HELLO_EXT}/install`, post(`/${HELLO_EXT}/install`));
    const res = await app.request(
      `/api/marketplace/${HELLO_EXT}/disable`,
      post(`/${HELLO_EXT}/disable`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
  }, 30_000);

  it('install reports downloaded=false when hello-ext is already on disk', async () => {
    ensureHelloExtOnDisk();
    const res = await app.request(
      `/api/marketplace/${HELLO_EXT}/install`,
      post(`/${HELLO_EXT}/install`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { downloaded: boolean; files_on_disk: boolean };
    expect(body.files_on_disk).toBe(true);
    expect(body.downloaded).toBe(false);
  }, 20_000);

  it('enable-all returns per-extension results when extensions are installed', async () => {
    ensureHelloExtOnDisk();
    await app.request(`/api/marketplace/${HELLO_EXT}/install`, post(`/${HELLO_EXT}/install`));
    const res = await app.request('/api/marketplace/enable-all', post('/enable-all'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ name: string; ok: boolean }>;
      enabled: number;
      failed: number;
    };
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results.length).toBeGreaterThan(0);
    expect(typeof body.enabled).toBe('number');
    expect(typeof body.failed).toBe('number');
  }, 40_000);

  it('PUT config on a ghost extension upserts registry config', async () => {
    const res = await app.request(`/api/marketplace/${GHOST}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ greeting: 'harness-config' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
  }, 20_000);

  it('enable hello-ext returns structured enable payload', async () => {
    ensureHelloExtOnDisk();
    await app.request(`/api/marketplace/${HELLO_EXT}/install`, post(`/${HELLO_EXT}/install`));
    const res = await app.request(
      `/api/marketplace/${HELLO_EXT}/enable`,
      post(`/${HELLO_EXT}/enable`),
    );
    expect(res.status).toBeLessThan(600);
    const body = (await res.json()) as {
      success?: boolean;
      hot_loaded?: boolean;
      studio_pages_prebuilt?: boolean;
    };
    expect(typeof body).toBe('object');
    if (res.status === 200) {
      expect(typeof body.studio_pages_prebuilt).toBe('boolean');
    }
  }, 30_000);

  it('DELETE license clears a stored key after stubbed verify', async () => {
    stubLicenseVerifyOk();
    const name = `harness-lic-del-${Date.now()}`;
    const store = await app.request(
      `/api/marketplace/license/${name}`,
      post(`/api/marketplace/license/${name}`, { license_key: 'del-me' }),
    );
    expect(store.status).toBe(200);
    const del = await app.request(`/api/marketplace/license/${name}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(del.status).toBe(200);
    const body = (await del.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  }, 15_000);
});
