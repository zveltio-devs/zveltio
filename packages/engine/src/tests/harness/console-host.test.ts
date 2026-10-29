// With ZVELTIO_CONSOLE_HOST set, the Console and configuration answer only on
// that host: `/admin`, `/api/admin/*`, every configuration mutation and every
// extension mutation authorized against `admin` are 404 on any other host, while
// what the App uses still answers there. On the console host a request a page
// on another host sent (its Origin) is refused, so a script on the main domain
// cannot ride the Console's cookie: that cookie is host-only, but the two hosts
// are same-site, so SameSite=Lax would still attach it. Unset: unchanged.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getAuth } from '../../lib/auth.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import { engineEvents } from '../../lib/runtime/index.js';
import { consoleHostProblem } from '../../middleware/console-host.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = String(Date.now()).slice(-7);
const EXT = `conhost${SFX}`;
const CONSOLE = 'admin.conhost.test';
const MAIN = 'http://app.conhost.test';
const ADMIN = `http://${CONSOLE}`;

const entry = `
export default {
  name: '${EXT}',
  mountStrategy: 'subapp',
  async register(app, ctx) {
    app.post('/admin/settings', async (c) =>
      (await ctx.checkPermission(c.get('user').id, 'admin', '*'))
        ? c.json({ saved: true })
        : c.json({ error: 'no' }, 403));
  },
};
`;

d('ZVELTIO_CONSOLE_HOST fences the Console and configuration by host', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let base = '';
  const extApp = new Hono();
  const saved = { host: process.env.ZVELTIO_CONSOLE_HOST, ctx: extensionLoader.ctx };

  const req = (url: string, method = 'GET', headers: Record<string, string> = {}) =>
    app.request(url, {
      method,
      headers: { cookie, 'content-type': 'application/json', ...headers },
      body: method === 'GET' ? undefined : '{}',
    });
  // A config mutation the handler refuses on its body (400): it got past the
  // host fence and the step-up window, and wrote nothing.
  const createCollection = (origin: string, headers: Record<string, string> = {}) =>
    req(`${origin}/api/collections`, 'POST', headers);
  const extMutation = (origin: string) =>
    extApp.request(`${origin}/ext/${EXT}/admin/settings`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);

    extApp.use('/ext/*', sessionPrefetch(getAuth(), db));
    extApp.use('/ext/*', tenantMiddleware);
    extApp.use('/ext/*', extensionAuthGate(getAuth() as never, db));
    _setInlineForTests(true);
    const ctx = {
      ...(extensionLoader.ctx ?? {}),
      db,
      auth: getAuth(),
      events: engineEvents,
      fieldTypeRegistry: { register() {} },
    } as never;
    extensionLoader.ctx = ctx;
    base = mkdtempSync(join(tmpdir(), 'conhost-'));
    mkdirSync(join(base, EXT, 'engine'), { recursive: true });
    writeFileSync(
      join(base, EXT, 'manifest.json'),
      JSON.stringify({
        name: EXT,
        version: '1.0.0',
        engine: { entry: 'engine/index.js', bundled: true },
      }),
    );
    writeFileSync(join(base, EXT, 'engine', 'index.js'), entry);
    await sql`INSERT INTO zv_extension_registry
                (name, display_name, tenant_id, is_installed, is_enabled)
              VALUES (${EXT}, ${EXT}, NULL, true, true)`.execute(db);
    await extensionLoader.loadExtension(EXT, extApp, ctx, base);
    expect(extensionLoader.getLastLoadError(EXT)).toBeUndefined();
  }, 120_000);

  afterAll(async () => {
    if (saved.host === undefined) delete process.env.ZVELTIO_CONSOLE_HOST;
    else process.env.ZVELTIO_CONSOLE_HOST = saved.host;
    extensionLoader.ctx = saved.ctx;
    _setInlineForTests(false);
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT}`.execute(db);
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it('unset: everything answers on any host', async () => {
    delete process.env.ZVELTIO_CONSOLE_HOST;
    expect((await createCollection(MAIN)).status).toBe(400);
    expect((await req(`${MAIN}/api/admin/rls`)).status).not.toBe(404);
    expect((await req(`${MAIN}/admin/`)).status).not.toBe(404);
    expect((await extMutation(MAIN)).status).toBe(200);
    // A foreign Origin is not refused either: no console host, no fence.
    expect((await createCollection(MAIN, { origin: 'http://elsewhere.test' })).status).toBe(400);
  });

  it('set: configuration and the Console are 404 on the main host', async () => {
    process.env.ZVELTIO_CONSOLE_HOST = CONSOLE;
    expect((await createCollection(MAIN)).status).toBe(404);
    expect((await req(`${MAIN}/api/admin/rls`)).status).toBe(404);
    expect((await req(`${MAIN}/admin/`)).status).toBe(404);
    expect((await req(`${MAIN}/admin`)).status).toBe(404);
    expect((await extMutation(MAIN)).status).toBe(404);
    expect((await req(`${MAIN}/api/auth/cli/deny`, 'POST')).status).toBe(404);
  });

  it('set: what the App uses still answers on the main host', async () => {
    process.env.ZVELTIO_CONSOLE_HOST = CONSOLE;
    expect((await req(`${MAIN}/api/collections`)).status).toBe(200);
    expect((await req(`${MAIN}/api/me`)).status).toBe(200);
  });

  it('set: on the console host configuration passes its normal checks', async () => {
    process.env.ZVELTIO_CONSOLE_HOST = CONSOLE;
    expect((await createCollection(ADMIN)).status).toBe(400);
    // The host is matched without its port and case-insensitively.
    expect((await createCollection('http://ADMIN.conhost.test:8443')).status).toBe(400);
    expect((await createCollection(ADMIN, { origin: ADMIN })).status).toBe(400);
    expect((await req(`${ADMIN}/api/admin/rls`)).status).not.toBe(404);
    expect((await req(`${ADMIN}/admin/`)).status).not.toBe(404);
    expect((await extMutation(ADMIN)).status).toBe(200);
    // Past the fence, the route refuses a missing code itself.
    expect((await req(`${ADMIN}/api/auth/cli/deny`, 'POST')).status).toBe(400);
    // Without a session the route's own guard answers, not the fence.
    expect((await app.request(`${ADMIN}/api/collections`, { method: 'POST' })).status).toBe(401);
  });

  it('set: the console host refuses a request another host’s page sent', async () => {
    process.env.ZVELTIO_CONSOLE_HOST = CONSOLE;
    for (const origin of [MAIN, 'null', 'https://admin.conhost.test.evil.test']) {
      expect({ origin, status: (await createCollection(ADMIN, { origin })).status }).toEqual({
        origin,
        status: 403,
      });
    }
    expect((await req(`${ADMIN}/api/admin/rls`, 'GET', { origin: MAIN })).status).toBe(403);
    // An identity provider's form_post comes back from its own origin.
    const idp = await app.request(`${ADMIN}/api/auth/callback/apple`, {
      method: 'POST',
      headers: { origin: 'https://appleid.apple.com' },
    });
    expect(await idp.text()).not.toContain('console host');
  });

  it('set: the Console session cookie is host-only', async () => {
    process.env.ZVELTIO_CONSOLE_HOST = CONSOLE;
    const { rows } = await sql<{ email: string }>`
      SELECT email FROM "user" WHERE role = 'god'`.execute(db);
    const res = await app.request(`${ADMIN}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ADMIN },
      body: JSON.stringify({ email: rows[0]?.email, password: 'HarnessGod123!' }),
    });
    expect(res.status).toBe(200);
    const set = res.headers.getSetCookie().filter((c) => c.includes('session_token='));
    expect(set.length).toBeGreaterThan(0);
    for (const c of set) expect(c.toLowerCase()).not.toContain('domain=');
  });

  it('startup validation takes a bare hostname only', () => {
    expect(consoleHostProblem(undefined)).toBeNull();
    expect(consoleHostProblem('')).toBeNull();
    expect(consoleHostProblem('admin.example.com')).toBeNull();
    expect(consoleHostProblem('localhost')).toBeNull();
    for (const bad of [
      'https://admin.example.com',
      'admin.example.com:8443',
      'admin.example.com/admin',
      '*.example.com',
      'admin..example.com',
      ' admin.example.com',
      '-admin.example.com',
    ]) {
      expect({ bad, ok: consoleHostProblem(bad) === null }).toEqual({ bad, ok: false });
    }
  });
});
