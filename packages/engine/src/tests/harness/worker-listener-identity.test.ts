// A worker-isolated `ctx.events.on` listener delivered during a request answers
// `checkPermission` as that request's user, as an inline listener (which runs in
// the emitter's async context) does. It used to be delivered with the tenant and
// no user, so `checkPermission` said false for everyone there. The user is the
// engine's record of the emitting request, never the payload's claim: another id
// is refused, and an event emitted outside any request (cron, background) is
// delivered with no user at all — nor a worker timer's, though the worker was
// spawned inside a request (its message handler ran in that request's context
// and delivered as its tenant). No session rides along: only the user id; nor
// the emitter's transaction, which a late listener met already committed.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getAuth } from '../../lib/auth.js';
import { revokeExtensionDbRoles } from '../../lib/extensions/ext-db-role.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import { engineEvents } from '../../lib/runtime/index.js';
import {
  DEFAULT_TENANT_ID,
  getEnforcer,
  onAfterCommit,
  runWithDomain,
  setRequestActor,
} from '../../lib/tenancy/index.js';
import { _resetWorkerHostForTests, getWorkerHost } from '../../lib/worker-extension-host.js';
import { extensionAuthGate } from '../../middleware/extension-auth-gate.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = String(Date.now()).slice(-7);
const WORKER = `wlnw${SFX}`;
const INLINE = `wlni${SFX}`;
const ALL = [WORKER, INLINE];
const RES = `wln_res_${SFX}`;
const PING = `${WORKER}.ping`;
const PONG = `${WORKER}.pong`;

// The listener reports what it was answered, and whether it got a session.
const fire = `
    app.get('/fire', async (c) => {
      await ctx.events.emitAsync('${PING}', {
        uid: c.req.query('id') ?? c.get('user').id,
        tag: c.req.query('tag'),
      });
      return c.json({ ok: true });
    });
`;

// `bg` is emitted by a timer the worker starts in `register()`: no invocation,
// so the host call names no request and the host emits in its own message
// context. The worker is spawned inside a request's context (below), so that
// context must not be what the listener is delivered as.
const workerEntry = (memberId: string) => `
export default {
  name: '${WORKER}',
  mountStrategy: 'subapp',
  async register(app, ctx) {
    ctx.events.on('${PING}', async (p, meta) => {
      if (p.wait) await new Promise((r) => setTimeout(r, p.wait));
      const out = { tag: p.tag, tenant: meta?.tenantId ?? null };
      try {
        out.read = await ctx.checkPermission(p.uid, '${RES}', 'read');
        out.del = await ctx.checkPermission(p.uid, '${RES}', 'delete');
        out.session = (await ctx.auth.api.getSession()) !== null;
        out.denial = JSON.stringify(await ctx.describeDenial('${RES}', 'delete'));
      } catch (err) {
        out.error = err.message;
      }
      ctx.events.emit('${PONG}', out);
    });
    // Until the worker stops: the case may run any time after the load.
    setInterval(() => ctx.events.emit('${PING}', { uid: '${memberId}', tag: 'bg' }), 250);
    ${fire}
  },
};
`;

const inlineEntry = `
export default {
  name: '${INLINE}',
  mountStrategy: 'subapp',
  async register(app, ctx) {
    ${fire}
  },
};
`;

function writeExt(base: string, name: string, entry: string, worker: boolean) {
  const dir = join(base, name);
  mkdirSync(join(dir, 'engine'), { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      dependencies: worker ? [] : [{ name: WORKER }],
      apiKeyRoutes: ['GET /fire'],
      engine: {
        entry: 'engine/index.js',
        bundled: true,
        ...(worker ? { isolation: 'worker' } : {}),
      },
    }),
  );
  writeFileSync(join(dir, 'engine', 'index.js'), entry);
}

type Pong = {
  tag: string;
  tenant: string | null;
  read?: boolean;
  del?: boolean;
  session?: boolean;
  denial?: string;
  error?: string;
};

d('a worker event listener answers checkPermission as the emitting request', () => {
  let db: Database;
  let base = '';
  const app = new Hono();
  let godId = '';
  let memberId = '';
  let keyId = '';
  let godLinkAdded = false;
  const asMember: Record<string, string> = {};
  const asKey: Record<string, string> = {};
  const saved = { transport: process.env.ZVELTIO_EXT_TRANSPORT, ctx: extensionLoader.ctx };
  const pongs = new Map<string, (p: Pong) => void>();
  let offPong = () => {};

  beforeAll(async () => {
    const { app: engine, db: tdb } = await getTestApp();
    db = tdb;
    const godCookie = await createGodSession(engine, db);
    godId = (
      await sql<{ id: string }>`SELECT id FROM "user" WHERE role = 'god' LIMIT 1`.execute(db)
    ).rows[0]!.id;
    const member = await createMemberSession(engine, db, {
      grants: [{ collection: RES, actions: ['read'] }],
    });
    memberId = member.userId;
    // Taken back in afterAll only if this file is what granted it.
    godLinkAdded = await (await getEnforcer()).addRoleForUser(
      godId,
      'tenant_admin',
      DEFAULT_TENANT_ID,
    );
    asMember.cookie = member.cookie;
    // The listener's check answers a key by its own scope, as inline: `$ext:<worker>`.
    const keyRes = await engine.request('/api/admin/api-keys', {
      method: 'POST',
      headers: { cookie: godCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `wln-${SFX}`,
        scopes: ALL.map((n) => ({ collection: `$ext:${n}`, actions: ['read'] })),
      }),
    });
    const key = (await keyRes.json()) as { id: string; key: string };
    keyId = key.id;
    asKey['x-api-key'] = key.key;

    app.use('/ext/*', sessionPrefetch(getAuth(), db));
    app.use('/ext/*', tenantMiddleware);
    app.use('/ext/*', extensionAuthGate(getAuth() as never, db));
    // An engine emit from inside a request: at once without waiting (the listener
    // runs after the commit), or from an after-commit job.
    app.use('/probe/*', sessionPrefetch(getAuth(), db));
    app.use('/probe/*', tenantMiddleware);
    app.get('/probe/fire', (c) => {
      const p = {
        uid: memberId,
        tag: c.req.query('tag'),
        wait: Number(c.req.query('wait') ?? 0),
      };
      if (c.req.query('when') === 'after')
        onAfterCommit(() => engineEvents.emit(PING as never, p as never));
      else engineEvents.emit(PING as never, p as never);
      return c.json({ ok: true });
    });
    _resetWorkerHostForTests();
    getWorkerHost(app);
    _setInlineForTests(true);
    const ctx = {
      ...(extensionLoader.ctx ?? {}),
      db,
      auth: getAuth(),
      events: engineEvents,
      fieldTypeRegistry: { register() {} },
      internals: buildExtensionInternals(),
    } as never;
    extensionLoader.ctx = ctx;
    process.env.ZVELTIO_EXT_TRANSPORT = 'process';
    offPong = engineEvents.on(PONG as never, ((p: Pong) => pongs.get(p.tag)?.(p)) as never);

    base = mkdtempSync(join(tmpdir(), 'wkr-lsn-id-'));
    writeExt(base, WORKER, workerEntry(memberId), true);
    writeExt(base, INLINE, inlineEntry, false);
    for (const name of ALL) {
      await sql`DELETE FROM zv_extension_registry WHERE name = ${name}`.execute(db);
      await sql`INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
                VALUES (${name}, ${name}, NULL, true, true)`.execute(db);
      // Spawned inside a request's context — a domain and an actor, as an enable
      // request has: the worker's message handler must not deliver as it.
      await runWithDomain(DEFAULT_TENANT_ID, () => {
        setRequestActor({ userId: memberId, identity: { userId: memberId } as never });
        return extensionLoader.loadExtension(name, app, ctx, base);
      });
      expect(extensionLoader.getLastLoadError(name)).toBeUndefined();
    }
  }, 120_000);

  afterAll(async () => {
    offPong();
    await getWorkerHost(app).stopAll();
    if (saved.transport === undefined) delete process.env.ZVELTIO_EXT_TRANSPORT;
    else process.env.ZVELTIO_EXT_TRANSPORT = saved.transport;
    extensionLoader.ctx = saved.ctx;
    _setInlineForTests(false);
    _resetWorkerHostForTests();
    for (const name of ALL) {
      extensionLoader.loaded.delete(name);
      await sql`DELETE FROM zv_extension_registry WHERE name = ${name}`.execute(db);
      await revokeExtensionDbRoles(db, name, true).catch(() => undefined);
    }
    if (keyId) await sql`DELETE FROM zv_api_keys WHERE id = ${keyId}`.execute(db);
    if (godLinkAdded)
      await (await getEnforcer()).deleteRoleForUser(godId, 'tenant_admin', DEFAULT_TENANT_ID);
    if (base) rmSync(base, { recursive: true, force: true });
  });

  let n = 0;
  /** What the listener answered for the event `emit` fires under a fresh tag. */
  const heard = async (emit: (tag: string) => unknown): Promise<Pong> => {
    const tag = `t${++n}`;
    const got = new Promise<Pong>((resolve, reject) => {
      pongs.set(tag, resolve);
      setTimeout(() => reject(new Error(`no pong for ${tag}`)), 15_000);
    });
    await emit(tag);
    return got;
  };
  const via = (ext: string, headers: Record<string, string>, id?: string) => (tag: string) =>
    app.request(`/ext/${ext}/fire?tag=${tag}${id ? `&id=${encodeURIComponent(id)}` : ''}`, {
      headers,
    });

  for (const [emitter, kind] of [
    [INLINE, 'inline'],
    [WORKER, 'worker'],
  ] as const) {
    it(`${kind} emitter: the member's own grant answers true, a missing one false`, async () => {
      expect(await heard(via(emitter, asMember))).toMatchObject({
        read: true,
        del: false,
        session: false,
      });
    });

    it(`${kind} emitter with an API key: answered by the key's scope`, async () => {
      expect(await heard(via(emitter, asKey))).toMatchObject({
        read: true,
        del: false,
      });
    });

    it(`${kind} emitter: a user other than the request's is refused, even the god`, async () => {
      expect(await heard(via(emitter, asMember, godId))).toMatchObject({ read: false });
    });
  }

  it('emitted outside any request (cron, background) there is no user: false', async () => {
    const p = await heard(async (tag) =>
      engineEvents.emit(PING as never, { uid: memberId, tag } as never),
    );
    expect(p).toMatchObject({ read: false, session: false });
  });

  it('a worker timer emits with no request: no user, no tenant — though spawned in one', async () => {
    const p = await new Promise<Pong>((resolve, reject) => {
      pongs.set('bg', resolve);
      setTimeout(() => reject(new Error('no pong for bg')), 15_000);
    });
    expect(p).toMatchObject({ tenant: null, read: false, session: false });
    expect(p.error).toBeUndefined();
  });

  it('emitted from an after-commit job: the tenant, no user', async () => {
    const p = await heard((tag) =>
      app.request(`/probe/fire?tag=${tag}&when=after`, { headers: asMember }),
    );
    // The job runs in the context outside the request's transaction: its tenant,
    // and no actor — so no user, and no finished transaction to meet.
    expect(p).toMatchObject({ tenant: DEFAULT_TENANT_ID, read: false });
    expect(p.error).toBeUndefined();
    // A finished transaction answered no granters at all (`[]`); which ones
    // depends on who else the database holds (LIMIT in denial.ts).
    expect(JSON.parse(p.denial ?? '{}').canGrant?.length).toBeGreaterThan(0);
  });

  it('emitted without waiting, the listener running after the request committed', async () => {
    const p = await heard((tag) =>
      app.request(`/probe/fire?tag=${tag}&wait=300`, { headers: asMember }),
    );
    expect(p).toMatchObject({ tenant: DEFAULT_TENANT_ID, read: true, del: false });
    expect(p.error).toBeUndefined();
    // Answered outside the emitter's transaction, which has committed by now.
    // A finished transaction answered no granters at all (`[]`); which ones
    // depends on who else the database holds (LIMIT in denial.ts).
    expect(JSON.parse(p.denial ?? '{}').canGrant?.length).toBeGreaterThan(0);
  });
});
