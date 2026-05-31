/**
 * Marketplace lifecycle — Integration Tests (alpha.126).
 *
 * Exercises the full install → enable → invoke flow against a
 * running engine + Postgres. Covers BOTH the inline subapp path
 * (hello-ext) and the C-minimal worker isolation path
 * (hello-ext-worker). The release-binary smoke job runs the same
 * shape against the compiled binary; this suite catches regressions
 * earlier — during `bun test`, before the build.
 *
 * EXPLICIT OPT-IN. The suite is OFF by default because it needs a
 * full live setup (engine running, god user provisioned, fixtures
 * copied into EXTENSIONS_DIR) that the standard `bun test
 * test:integration` runner doesn't provide. To enable:
 *
 *   1. Boot the engine at TEST_PORT (default 3099) with
 *      EXTENSIONS_DIR pointing at a folder containing both
 *      `hello-ext/` and `hello-ext-worker/` fixtures.
 *   2. Create a god user with TEST_USER_EMAIL / TEST_USER_PASSWORD.
 *   3. Set ENABLE_MARKETPLACE_INTEGRATION_TESTS=1.
 *   4. Run `bun test packages/engine/src/tests/integration/marketplace-lifecycle.integration.test.ts`.
 *
 * The release-binary smoke job in `.github/workflows/release.yml`
 * already exercises this same flow end-to-end against the compiled
 * binary — so CI coverage doesn't depend on this suite running.
 */

import { describe, it, expect, beforeAll } from 'bun:test';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const TEST_PORT = process.env.TEST_PORT || '3099';
const BASE_URL = `http://localhost:${TEST_PORT}`;
const EMAIL = process.env.TEST_USER_EMAIL || 'smoke@test.invalid';
const PASSWORD = process.env.TEST_USER_PASSWORD || 'SmokePass123!';

// Explicit opt-in: skip unless caller has the full marketplace fixture
// pipeline staged (live engine + god user + fixtures in EXTENSIONS_DIR).
const skipAll =
  !TEST_DB_URL || process.env.ENABLE_MARKETPLACE_INTEGRATION_TESTS !== '1';

let sessionCookie = '';

async function signIn(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`sign-in failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = setCookie.match(/better-auth\.session_token=([^;]+)/);
  if (!match) throw new Error('sign-in response had no session cookie');
  sessionCookie = `better-auth.session_token=${match[1]}`;
}

function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      Cookie: sessionCookie,
    },
  });
}

describe.skipIf(skipAll)('Marketplace lifecycle — inline (hello-ext)', () => {
  beforeAll(async () => {
    await signIn();
  });

  it('install → success:true, files_on_disk:true', async () => {
    const res = await authedFetch('/api/marketplace/hello-ext/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.files_on_disk).toBe(true);
  });

  it('enable → success:true, hot_loaded:true', async () => {
    const res = await authedFetch('/api/marketplace/hello-ext/enable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.hot_loaded).toBe(true);
  });

  it('GET /ext/hello-ext/health → 200 {ok:true}', async () => {
    const res = await authedFetch('/ext/hello-ext/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.name).toBe('hello-ext');
  });
});

describe.skipIf(skipAll)('Marketplace lifecycle — worker isolation (hello-ext-worker)', () => {
  it('install → success:true', async () => {
    const res = await authedFetch('/api/marketplace/hello-ext-worker/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('enable → success:true (spawns Bun.Worker)', async () => {
    const res = await authedFetch('/api/marketplace/hello-ext-worker/enable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('GET /ext/hello-ext-worker/health → runtime:"bun-worker" (proves worker IPC)', async () => {
    const res = await authedFetch('/ext/hello-ext-worker/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.runtime).toBe('bun-worker');
    expect(body.isolation).toBe('worker');
  });
});

describe.skipIf(skipAll)('Admin extensions health endpoint', () => {
  it('GET /api/admin/extensions/health lists both fixtures with correct isolation tier', async () => {
    const res = await authedFetch('/api/admin/extensions/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.engine_rss_mb).toBe('number');
    const byName = new Map(
      (body.extensions as Array<{ name: string; isolation: string }>).map((e) => [e.name, e]),
    );
    const helloInline = byName.get('hello-ext');
    const helloWorker = byName.get('hello-ext-worker');
    expect(helloInline?.isolation).toBe('inline');
    expect(helloWorker?.isolation).toBe('worker');
  });
});

describe.skipIf(skipAll)('Marketplace install — invalid extension', () => {
  it('returns 404 for an extension not in the catalog', async () => {
    const res = await authedFetch('/api/marketplace/totally-nonexistent-ext-xyz/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });
});
