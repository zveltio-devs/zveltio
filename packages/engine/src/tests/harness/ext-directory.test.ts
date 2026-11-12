/**
 * ADR 0039 decision 9: directory provisioning is a narrow engine contract.
 *
 * Through the engine's own `/ext/*` chain and the real load path: an extension
 * holding `identity:provision` provisions, renames, suspends, lists and removes
 * accounts from a declared public route with `host.identity` — and reaches only
 * the accounts it provisioned, in the tenant the request runs in. Another
 * provider's account, another tenant's, an account it did not create: each is
 * refused as if it did not exist. Without the capability every call is a clean
 * 403; from a `caller` route it is the extension's bug. Each act leaves the
 * engine's audit entry with the provider as actor.
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
const STAMP = `${Date.now()}`.slice(-7) + Math.floor(Math.random() * 1e4);
const DIR = `dir${STAMP}`;
const OTHER = `diro${STAMP}`;
const NOCAP = `dirn${STAMP}`;
const SLUG = `dir-t-${STAMP}`;
const T = crypto.randomUUID();

type Rec = Record<string, unknown>;

/** `POST /dir {op, args}`: one `host.identity` call, a refusal answered as its status. */
const dir: RouteHandler = async (request, { host }) => {
  const { op, args = [] } = (await request.json()) as { op: string; args?: unknown[] };
  try {
    const fn = (host.identity as unknown as Record<string, (...a: unknown[]) => unknown>)[op]!;
    return Response.json({ out: (await fn(...args)) ?? null });
  } catch (err) {
    const e = err as { code?: string; status?: number; message: string };
    return Response.json({ code: e.code ?? null, error: e.message }, { status: e.status ?? 500 });
  }
};

const manifest = (permissions: string[]): Rec => ({
  permissions,
  routes: [
    { method: 'POST', path: '/dir', access: 'public', handler: 'dir' },
    { method: 'POST', path: '/mine', access: 'caller', handler: 'dir' },
  ],
});

d('directory provisioning is a narrow engine contract (ADR 0039 decision 9)', () => {
  let engine: Hono;
  let db: Database;
  let app: Hono;
  let n = 0;
  const email = (tag: string) => `${tag}-${STAMP}-${++n}@directory.test`;

  async function load(name: string, permissions: string[]) {
    const ext: ZveltioExtension = {
      name,
      category: 'auth',
      mountStrategy: 'subapp',
      routes: { dir },
      async register() {},
    };
    const parsed = ManifestSchema.parse({ name, version: '1.0.0', ...manifest(permissions) });
    await sql`DELETE FROM zv_extension_registry WHERE name = ${name}`.execute(db);
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled, manifest)
      VALUES (${name}, ${name}, NULL, true, true, ${toJsonb(parsed)})
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
      name,
      `/tmp/${name}`,
      app,
      ctx,
      parsed as never,
      new Set(),
    );
  }

  /** One `host.identity` call by `ext`, in `tenant` (a slug) or the default tenant. */
  async function call(
    ext: string,
    op: string,
    args: unknown[],
    opts: { tenant?: string; path?: string; cookie?: string } = {},
  ): Promise<{ status: number; out: Rec | Rec[] | null; code: string | null; error?: string }> {
    const res = await app.request(`/ext/${ext}${opts.path ?? '/dir'}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.tenant ? { 'x-tenant-slug': opts.tenant } : {}),
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
      },
      body: JSON.stringify({ op, args }),
    });
    const body = (await res.json()) as Rec;
    return {
      status: res.status,
      out: (body.out ?? null) as Rec | null,
      code: (body.code ?? null) as string | null,
      ...(typeof body.error === 'string' ? { error: body.error } : {}),
    };
  }
  const inT = { tenant: SLUG };

  const audit = (subject: string) =>
    asEveryTenant(
      db,
      async (trx) =>
        (
          await sql<Rec>`
          SELECT event_type, tenant_id::text AS tenant, resource_id,
                 metadata->>'actor' AS actor, metadata->>'provider' AS provider
            FROM zv_audit_log
           WHERE event_type LIKE 'identity.%' AND metadata->>'subject' = ${subject}
           ORDER BY created_at, id`.execute(trx)
        ).rows,
    );
  const membership = async (userId: string) =>
    (
      await sql<{ in_force: boolean }>`
        SELECT valid_to IS NULL OR valid_to > now() AS in_force FROM zv_tenant_users
         WHERE tenant_id = ${T}::uuid AND user_id = ${userId}`.execute(db)
    ).rows[0];
  const userRow = async (id: string) =>
    (
      await sql<{ name: string; banned: boolean | null }>`
        SELECT name, banned FROM "user" WHERE id = ${id}`.execute(db)
    ).rows[0];

  beforeAll(async () => {
    ({ app: engine, db } = await getTestApp());
    _setInlineForTests(true);
    await createGodSession(engine, db);
    await sql`INSERT INTO zv_tenants (id, slug, name) VALUES (${T}::uuid, ${SLUG}, 'Directory T')`.execute(
      db,
    );
    app = new Hono();
    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));
    await load(DIR, ['identity:provision']);
    await load(OTHER, ['identity:provision']);
    await load(NOCAP, []);
    invalidateActivationCache();
  }, 60_000);

  afterAll(async () => {
    invalidateActivationCache();
    if (!db) return;
    await sql`DELETE FROM zv_extension_registry WHERE name IN (${DIR}, ${OTHER}, ${NOCAP})`.execute(
      db,
    );
    await sql`DELETE FROM "user" WHERE email LIKE ${`%-${STAMP}-%@directory.test`}`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id = ${T}::uuid`.execute(db).catch(() => {});
  });

  it('provision, get, list, update, setActive, remove: each on the account it provisioned, each audited', async () => {
    const subject = `s-${STAMP}-life`;
    const address = email('life');
    const made = await call(DIR, 'provision', [{ subject, email: address, name: 'First' }], inT);
    expect(made.status, made.error).toBe(200);
    const acc = made.out as Rec;
    expect(acc).toMatchObject({ subject, email: address, name: 'First', active: true });
    const id = String(acc.id);
    expect(await membership(id)).toEqual({ in_force: true });

    expect((await call(DIR, 'get', [subject], inT)).out).toMatchObject({ id, active: true });
    const listed = (await call(DIR, 'list', [{ email: address }], inT)).out as Rec[];
    expect(listed.map((a) => a.subject)).toEqual([subject]);

    const renamed = await call(DIR, 'update', [subject, { name: 'Renamed' }], inT);
    expect([renamed.status, (renamed.out as Rec).name]).toEqual([200, 'Renamed']);
    expect((await userRow(id))?.name).toBe('Renamed');

    // Multi-tenant: off ends the membership here (no tenant left in force: blocked).
    const off = await call(DIR, 'setActive', [subject, false], inT);
    expect([off.status, (off.out as Rec).active]).toEqual([200, false]);
    expect(await membership(id)).toEqual({ in_force: false });
    expect((await userRow(id))?.banned).toBe(true);
    const on = await call(DIR, 'setActive', [subject, true], inT);
    expect([on.status, (on.out as Rec).active]).toEqual([200, true]);
    expect(await membership(id)).toEqual({ in_force: true });
    expect((await userRow(id))?.banned).toBe(false);

    const gone = await call(DIR, 'remove', [subject], inT);
    expect(gone.status, gone.error).toBe(200);
    // Nothing else held the account: it went, and the link with it.
    expect(await userRow(id)).toBeUndefined();
    expect((await call(DIR, 'get', [subject], inT)).out).toBeNull();

    const rows = await audit(subject);
    expect(rows.map((r) => r.event_type)).toEqual([
      'identity.provisioned',
      'identity.updated',
      'identity.active_set',
      'identity.active_set',
      'identity.removed',
    ]);
    for (const r of rows) {
      expect(r).toMatchObject({ tenant: T, resource_id: id, actor: `ext:${DIR}`, provider: DIR });
    }
  }, 30_000);

  it("refuses another provider's account, another tenant's, and one it did not provision", async () => {
    // Another provider's, in the same tenant.
    const theirs = `s-${STAMP}-theirs`;
    const theirAddress = email('theirs');
    expect(
      (await call(OTHER, 'provision', [{ subject: theirs, email: theirAddress }], inT)).status,
    ).toBe(200);
    // Its own, in the other (default) tenant: not reachable from T.
    const elsewhere = `s-${STAMP}-elsewhere`;
    const made = await call(DIR, 'provision', [{ subject: elsewhere, email: email('elsewhere') }]);
    expect(made.status, made.error).toBe(200);
    const elsewhereId = String((made.out as Rec).id);
    // A member of T nobody provisioned, named by its user id.
    const localId = crypto.randomUUID();
    const localAddress = email('local');
    await sql`
      INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt")
      VALUES (${localId}, ${localAddress}, 'Local', true, NOW(), NOW())`.execute(db);
    await sql`
      INSERT INTO zv_tenant_users (tenant_id, user_id, role) VALUES (${T}::uuid, ${localId}, 'member')`.execute(
      db,
    );

    for (const subject of [theirs, elsewhere, localId]) {
      expect((await call(DIR, 'get', [subject], inT)).out).toBeNull();
      for (const [op, args] of [
        ['update', [subject, { name: 'Taken over' }]],
        ['setActive', [subject, false]],
        ['remove', [subject]],
      ] as const) {
        const r = await call(DIR, op, [...args], inT);
        expect([op, subject, r.status, r.code]).toEqual([op, subject, 404, 'no_such_user']);
      }
    }
    // A listing is the provider's accounts only.
    const all = (await call(DIR, 'list', [{ limit: 1000 }], inT)).out as Rec[];
    expect(all.map((a) => a.subject)).not.toContain(theirs);
    expect(all.map((a) => a.id)).not.toContain(localId);
    expect(all.map((a) => a.id)).not.toContain(elsewhereId);
    // Nothing changed.
    expect(await userRow(localId)).toEqual({ name: 'Local', banned: null });
    expect(await membership(localId)).toEqual({ in_force: true });
    expect((await userRow(elsewhereId))?.banned ?? null).toBeNull();
    expect((await call(OTHER, 'get', [theirs], inT)).out).toMatchObject({ active: true });

    // Naming an existing account's address claims nothing.
    const claim = await call(
      DIR,
      'provision',
      [{ subject: `s-${STAMP}-claim`, email: localAddress }],
      inT,
    );
    expect([claim.status, claim.code]).toEqual([409, 'account_exists']);
    expect((await call(DIR, 'get', [`s-${STAMP}-claim`], inT)).out).toBeNull();
    // Nor does reusing a subject.
    const again = await call(OTHER, 'provision', [{ subject: theirs, email: email('again') }], inT);
    expect([again.status, again.code]).toEqual([409, 'account_exists']);
  }, 30_000);

  it('a membership the business ended is read and removed, not changed', async () => {
    const subject = `s-${STAMP}-lapsed`;
    const made = await call(DIR, 'provision', [{ subject, email: email('lapsed') }], inT);
    const id = String((made.out as Rec).id);
    await sql`UPDATE zv_tenant_users SET valid_to = now() - interval '1 hour'
               WHERE tenant_id = ${T}::uuid AND user_id = ${id}`.execute(db);
    expect((await call(DIR, 'get', [subject], inT)).out).toMatchObject({ active: false });
    for (const [op, args] of [
      ['update', [subject, { name: 'No' }]],
      ['setActive', [subject, true]],
    ] as const) {
      const r = await call(DIR, op, [...args], inT);
      expect([op, r.status, r.code]).toEqual([op, 403, 'not_in_force']);
    }
    expect((await call(DIR, 'remove', [subject], inT)).status).toBe(200);
  }, 30_000);

  it('refuses without identity:provision (403) and from a caller route (the extension bug)', async () => {
    const subject = `s-${STAMP}-nocap`;
    const address = email('nocap');
    for (const op of ['provision', 'list', 'get']) {
      const r = await call(
        NOCAP,
        op,
        op === 'provision' ? [{ subject, email: address }] : [subject],
        inT,
      );
      expect([op, r.status, r.code]).toEqual([op, 403, 'capability_required']);
    }
    const onCaller = await call(DIR, 'provision', [{ subject, email: address }], {
      ...inT,
      path: '/mine',
      cookie: await createGodSession(engine, db),
    });
    expect([onCaller.status, onCaller.error]).toEqual([
      500,
      `${DIR}: host.identity answers only on a declared public route`,
    ]);
    expect(
      (await sql`SELECT 1 FROM "user" WHERE email = ${address}`.execute(db)).rows,
    ).toHaveLength(0);
  }, 30_000);

  it('the directory internals are no longer offered to extensions (deleteUser stays: GDPR erasure)', () => {
    const all = buildExtensionInternals() as unknown as Rec;
    for (const m of [
      'provisionUser',
      'listTenantUsers',
      'updateUserProfile',
      'setUserActive',
      'liftOwnBan',
      'addTenantMember',
      'removeTenantMember',
      'setTenantMembershipEnd',
      'revokeUserSessions',
    ]) {
      expect([m, all[m]]).toEqual([m, undefined]);
    }
  });
});
