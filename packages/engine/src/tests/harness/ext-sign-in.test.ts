/**
 * ADR 0039 decisions 7 and 8: signing in is one engine operation, and the
 * engine lists the sign-in providers extensions declare.
 *
 * Through the engine's own `/ext/*` chain and the real load path: an extension
 * holding `auth:session` signs a person in from a declared public route with
 * `host.identity.signIn` — the engine finds or creates the account, refuses a
 * disabled one or one the tenant has no claim to, opens the session and audits
 * success and failure with the provider as actor. Everywhere else signing in is
 * refused: a `caller` route, an extension without `auth:session`, a provider it
 * does not declare, a route mounted by `register` (no `identity` on its host),
 * and `ctx.internals`, which no longer offers `createBetterAuthSession`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { RouteHandler, ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { finalizeExtensionLoad } from '../../lib/extensions/register.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { ManifestSchema } from '../../lib/extensions/manifest-schema.js';
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import { getAuth } from '../../lib/auth.js';
import { engineEvents } from '../../lib/runtime/index.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import { toJsonb } from '../../lib/jsonb.js';
import {
  asEveryTenant,
  createGodSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = String(Date.now()).slice(-7);
const EXT = `sgn${STAMP}`;
const NOCAP = `sgnn${STAMP}`;

type Rec = Record<string, unknown>;

/** `POST /login {email, password, provider?}`: `ok` is the provider's yes. */
const login: RouteHandler = async (request, { host }) => {
  const { email, password, provider = 'dir' } = (await request.json()) as Rec;
  const identity = host.identity;
  if (!identity) return Response.json({ error: 'no identity' }, { status: 500 });
  try {
    if (password !== 'ok') {
      await identity.signInRefused({
        provider: String(provider),
        identifier: String(email),
        reason: 'bad password',
      });
      return Response.json({ error: 'refused' }, { status: 401 });
    }
    const { user, headers } = await identity.signIn({
      provider: String(provider),
      subject: `uid=${String(email)}`,
      email: String(email),
      name: 'Signed In',
    });
    return Response.json({ user }, { headers });
  } catch (err) {
    const e = err as { code?: string; status?: number; message: string };
    return Response.json({ code: e.code ?? null, error: e.message }, { status: e.status ?? 500 });
  }
};

/** Signs in, then fails: the request rolls back, and the session goes with it. */
const boom: RouteHandler = async (request, { host }) => {
  const { email } = (await request.json()) as Rec;
  await host.identity!.signIn({
    provider: 'dir',
    subject: `uid=${String(email)}`,
    email: String(email),
  });
  throw new Error('after the sign-in');
};

const manifest = (permissions: string[]): Rec => ({
  permissions,
  routes: [
    { method: 'POST', path: '/login', access: 'public', handler: 'login' },
    { method: 'GET', path: '/start', access: 'public', handler: 'start' },
    { method: 'POST', path: '/mine', access: 'caller', handler: 'login' },
    { method: 'POST', path: '/boom', access: 'public', handler: 'boom' },
  ],
  signInProviders: [
    { id: 'dir', label: 'Directory', kind: 'credentials', route: '/login' },
    { id: 'sso', label: 'Single sign-on', kind: 'redirect', route: '/start' },
  ],
});

d('signing in is one engine operation (ADR 0039 decisions 7, 8)', () => {
  let engine: Hono;
  let db: Database;
  let app: Hono;
  let godEmail = '';

  async function load(ext: ZveltioExtension, m: Rec) {
    const parsed = ManifestSchema.parse({ name: ext.name, version: '1.0.0', ...m });
    await sql`DELETE FROM zv_extension_registry WHERE name = ${ext.name}`.execute(db);
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled, manifest)
      VALUES (${ext.name}, ${ext.name}, NULL, true, true, ${toJsonb(parsed)})
    `.execute(db);
    const ctx = {
      db,
      auth: getAuth(),
      events: engineEvents,
      fieldTypeRegistry: { register() {} },
      internals: buildExtensionInternals(),
    } as unknown as ExtensionContext;
    const loader = {
      loaded: new Map(),
      modules: new Map(),
      lastLoadError: new Map(),
      extDirs: new Map(),
      forgetExtensionMessages: () => {},
      ctx,
    } as unknown as ExtensionLoader;
    await finalizeExtensionLoad(
      loader,
      ext,
      ext.name,
      `/tmp/${ext.name}`,
      app,
      ctx,
      parsed as never,
      new Set(),
    );
  }
  const extension = (name: string): ZveltioExtension => ({
    name,
    category: 'auth',
    mountStrategy: 'subapp',
    routes: { login, boom, start: () => new Response(null, { status: 204 }) },
    async register(r, ctx) {
      // A route `register` mounts, as an extension's own Hono route: no identity there.
      (r as Hono).get('/hono', (c) =>
        c.json({
          identity: typeof (ctx.host?.(c) as Rec | undefined)?.identity,
          createBetterAuthSession: typeof (ctx.internals as unknown as Rec).createBetterAuthSession,
        }),
      );
    },
  });
  const post = (ext: string, path: string, body: Rec, cookie?: string, tenant?: string) =>
    app.request(`/ext/${ext}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
        ...(tenant ? { 'x-tenant-slug': tenant } : {}),
      },
      body: JSON.stringify(body),
    });
  const sessionUser = async (setCookie: string | null) => {
    const res = await engine.request('/api/auth/get-session', {
      headers: { cookie: (setCookie ?? '').split(';')[0] ?? '' },
    });
    return ((await res.json().catch(() => null)) as { user?: { id: string } } | null)?.user?.id;
  };
  const audit = (type: string, email: string) =>
    asEveryTenant(
      db,
      async (trx) =>
        (
          await sql<Rec>`
          SELECT user_id, metadata->>'provider' AS provider, metadata->>'actor' AS actor,
                 metadata->>'reason' AS reason, metadata->>'subject' AS subject,
                 metadata->>'identifier' AS identifier
            FROM zv_audit_log
           WHERE event_type = ${type} AND metadata->>'actor' = ${`ext:${EXT}`}
             AND (metadata->>'subject' = ${`uid=${email}`} OR metadata->>'identifier' = ${email})`.execute(
            trx,
          )
        ).rows,
    );

  beforeAll(async () => {
    ({ app: engine, db } = await getTestApp());
    _setInlineForTests(true);
    await createGodSession(engine, db);
    godEmail = String(
      (await sql<Rec>`SELECT email FROM "user" WHERE role = 'god' LIMIT 1`.execute(db)).rows[0]
        ?.email,
    );
    app = new Hono();
    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));
    await load(extension(EXT), manifest(['auth:session']));
    await load(extension(NOCAP), manifest([]));
    invalidateActivationCache();
  }, 60_000);

  afterAll(async () => {
    invalidateActivationCache();
    if (!db) return;
    await sql`DELETE FROM zv_extension_registry WHERE name IN (${EXT}, ${NOCAP})`.execute(db);
  });

  it('signs a new person in: account, session, audit entry with the provider as actor', async () => {
    const email = `new-${STAMP}@sign-in.test`;
    const res = await post(EXT, '/login', { email, password: 'ok' });
    expect(res.status, await res.clone().text()).toBe(200);
    const { user } = (await res.json()) as { user: { id: string; email: string } };
    expect(user.email).toBe(email);
    expect(await sessionUser(res.headers.get('set-cookie'))).toBe(user.id);
    // No session cookie was sent: the bearer token too, signed.
    expect(res.headers.get('set-auth-token')).toContain('.');
    expect(await audit('auth.login_success', email)).toEqual([
      {
        user_id: user.id,
        provider: 'dir',
        actor: `ext:${EXT}`,
        reason: null,
        subject: `uid=${email}`,
        identifier: null,
      },
    ]);
  }, 30_000);

  it('a refusal at the provider leaves the engine audit entry', async () => {
    const email = `wrong-${STAMP}@sign-in.test`;
    const res = await post(EXT, '/login', { email, password: 'no' });
    expect(res.status).toBe(401);
    expect(await audit('auth.login_failed', email)).toEqual([
      {
        user_id: null,
        provider: 'dir',
        actor: `ext:${EXT}`,
        reason: 'bad password',
        subject: null,
        identifier: email,
      },
    ]);
  }, 30_000);

  it('refuses a disabled account: 403, no session, audited', async () => {
    const email = `banned-${STAMP}@sign-in.test`;
    const id = crypto.randomUUID();
    await sql`
      INSERT INTO "user" (id, email, name, "emailVerified", banned, "createdAt", "updatedAt")
      VALUES (${id}, ${email}, 'Banned', true, true, NOW(), NOW())`.execute(db);
    const res = await post(EXT, '/login', { email, password: 'ok' });
    expect([res.status, ((await res.json()) as Rec).code]).toEqual([403, 'account_disabled']);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect((await sql`SELECT 1 FROM session WHERE "userId" = ${id}`.execute(db)).rows).toHaveLength(
      0,
    );
    const rows = await audit('auth.login_failed', email);
    expect([rows.length, rows[0]]).toMatchObject([
      1,
      { user_id: id, provider: 'dir', reason: 'account_disabled' },
    ]);
  }, 30_000);

  it("refuses an account the tenant has no claim to (the instance owner's), audited", async () => {
    const res = await post(EXT, '/login', { email: godEmail, password: 'ok' });
    expect([res.status, ((await res.json()) as Rec).code]).toEqual([403, 'account_exists']);
    expect(res.headers.get('set-cookie')).toBeNull();
    const rows = await audit('auth.login_failed', godEmail);
    expect([rows.length, rows[0]]).toMatchObject([
      1,
      { provider: 'dir', reason: 'account_exists' },
    ]);
  }, 30_000);

  it('refuses a caller route, a provider it does not declare, and an extension without auth:session', async () => {
    const email = `nope-${STAMP}@sign-in.test`;
    const member = await createGodSession(engine, db);
    const onCaller = await post(EXT, '/mine', { email, password: 'ok' }, member);
    expect([onCaller.status, ((await onCaller.json()) as Rec).error]).toEqual([
      500,
      `${EXT}: host.identity answers only on a declared public route`,
    ]);
    const ghost = await post(EXT, '/login', { email, password: 'ok', provider: 'ghost' });
    expect([ghost.status, ((await ghost.json()) as Rec).error]).toEqual([
      500,
      `${EXT}: "ghost" is not one of its signInProviders`,
    ]);
    // Not the extension's bug but an approval missing: a clean refusal, not a 500.
    const noCap = await post(NOCAP, '/login', { email, password: 'ok' });
    expect([noCap.status, ((await noCap.json()) as Rec).code]).toEqual([
      403,
      'capability_required',
    ]);
    // Nothing signed in, nothing provisioned.
    for (const res of [onCaller, ghost, noCap]) expect(res.headers.get('set-cookie')).toBeNull();
    expect((await sql`SELECT 1 FROM "user" WHERE email = ${email}`.execute(db)).rows).toHaveLength(
      0,
    );
  }, 30_000);

  it('a route register mounts has no identity, and ctx.internals no createBetterAuthSession', async () => {
    const res = await app.request(`/ext/${EXT}/hono`, {
      headers: { cookie: await createGodSession(engine, db) },
    });
    expect(await res.json()).toEqual({
      identity: 'undefined',
      createBetterAuthSession: 'undefined',
    });
  }, 30_000);

  it('GET /api/sign-in/providers lists the providers of the extensions on in the tenant that may sign in', async () => {
    const list = async () =>
      (
        (await (await engine.request('/api/sign-in/providers')).json()) as { providers: Rec[] }
      ).providers.filter((p) => p.extension === EXT || p.extension === NOCAP);
    expect(await list()).toEqual([
      {
        id: 'dir',
        label: 'Directory',
        kind: 'credentials',
        extension: EXT,
        url: `/ext/${EXT}/login`,
      },
      {
        id: 'sso',
        label: 'Single sign-on',
        kind: 'redirect',
        extension: EXT,
        url: `/ext/${EXT}/start`,
      },
    ]);
    // Without `auth:session` (NOCAP) a provider is a dead button: not listed.
    await sql`UPDATE zv_extension_registry SET is_enabled = false WHERE name = ${EXT}`.execute(db);
    invalidateActivationCache();
    expect(await list()).toEqual([]);
    await sql`UPDATE zv_extension_registry SET is_enabled = true WHERE name = ${EXT}`.execute(db);
    invalidateActivationCache();
  }, 30_000);

  it('in a tenant other than the default, signs in only a person the tenant admits', async () => {
    const T = crypto.randomUUID();
    const slug = `sgn-t-${STAMP}`;
    await sql`INSERT INTO zv_tenants (id, slug, name) VALUES (${T}::uuid, ${slug}, 'Sign-in T')`.execute(
      db,
    );
    const person = async (tag: string, validTo: string | null) => {
      const id = crypto.randomUUID();
      const email = `${tag}-${STAMP}@sign-in.test`;
      await sql`
        INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt")
        VALUES (${id}, ${email}, ${tag}, true, NOW(), NOW())`.execute(db);
      await sql`
        INSERT INTO zv_tenant_users (tenant_id, user_id, role, valid_from, valid_to)
        VALUES (${T}::uuid, ${id}, 'member', now() - interval '2 days', ${validTo}::timestamptz)`.execute(
        db,
      );
      return { id, email };
    };
    try {
      const member = await person('t-member', null);
      const lapsed = await person('t-lapsed', new Date(Date.now() - 86_400_000).toISOString());
      const stranger = `t-stranger-${STAMP}@sign-in.test`;

      const ok = await post(
        EXT,
        '/login',
        { email: member.email, password: 'ok' },
        undefined,
        slug,
      );
      expect(ok.status, await ok.clone().text()).toBe(200);
      expect(await sessionUser(ok.headers.get('set-cookie'))).toBe(member.id);

      // Neither opens a session the tenant would refuse, nor leaves an account behind.
      for (const email of [lapsed.email, stranger]) {
        const res = await post(EXT, '/login', { email, password: 'ok' }, undefined, slug);
        expect([res.status, ((await res.json()) as Rec).code]).toEqual([403, 'not_a_member']);
        expect(res.headers.get('set-cookie')).toBeNull();
        expect((await audit('auth.login_failed', email))[0]).toMatchObject({
          reason: 'not_a_member',
        });
      }
      expect(
        (await sql`SELECT 1 FROM session WHERE "userId" = ${lapsed.id}`.execute(db)).rows,
      ).toHaveLength(0);
      expect(
        (await sql`SELECT 1 FROM "user" WHERE email = ${stranger}`.execute(db)).rows,
      ).toHaveLength(0);
    } finally {
      await sql`DELETE FROM zv_tenant_users WHERE tenant_id = ${T}::uuid`.execute(db);
      await sql`DELETE FROM zv_tenants WHERE id = ${T}::uuid`.execute(db).catch(() => {});
    }
  }, 30_000);

  it('a route that fails after signIn leaves neither the session nor the audit entry', async () => {
    const id = crypto.randomUUID();
    const email = `boom-${STAMP}@sign-in.test`;
    await sql`
      INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt")
      VALUES (${id}, ${email}, 'Boom', true, NOW(), NOW())`.execute(db);
    const res = await post(EXT, '/boom', { email });
    expect(res.status).toBe(500);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect((await sql`SELECT 1 FROM session WHERE "userId" = ${id}`.execute(db)).rows).toHaveLength(
      0,
    );
    expect(await audit('auth.login_success', email)).toEqual([]);
  }, 30_000);

  it('the manifest refuses a provider whose route is not a declared public route of its kind', () => {
    const parse = (signInProviders: Rec[]) =>
      ManifestSchema.safeParse({
        name: 'x',
        version: '1.0.0',
        ...manifest([]),
        signInProviders,
      }).error?.issues.map((i) => i.message);
    expect(parse([{ id: 'a', label: 'A', kind: 'redirect', route: '/login' }])).toEqual([
      'sign-in provider "a" (redirect) starts at GET /login, which is not a declared public route without parameters',
    ]);
    expect(parse([{ id: 'a', label: 'A', kind: 'credentials', route: '/mine' }])).toHaveLength(1);
    expect(
      parse([
        { id: 'a', label: 'A', kind: 'credentials', route: '/login' },
        { id: 'a', label: 'B', kind: 'redirect', route: '/start' },
      ]),
    ).toEqual(['sign-in provider "a" is declared twice']);
  });
});
