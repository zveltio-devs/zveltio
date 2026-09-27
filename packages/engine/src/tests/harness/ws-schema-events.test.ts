/**
 * Schema (DDL) events on the realtime socket.
 *
 * The SDK's `watchSchema` subscribed to a schema channel the engine never
 * published on, so it never fired. Now a collection's create/alter/drop is
 * announced after it lands, on `SCHEMA_CHANNEL`, to whoever may alter
 * collections — the collections routes' own gate, `requireInstanceAdmin`, asked
 * in the socket's tenant — to an API key holding the explicit `$schema` read
 * scope in the root tenant, and to nobody else. Collections are instance-wide,
 * so the event is too: a god on another tenant's host hears it.
 *
 * Driven the way a client and an administrator drive it: the real upgrade, the
 * real subscribe handler, DDL through `/api/collections` (the create through
 * the pg-boss worker), and the revoke through `/api/permissions/roles`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import { watchSchema } from '@zveltio/sdk';
import type { Database } from '../../db/index.js';
import {
  dispatchToWs,
  realtimeBus,
  type RealtimeBusMessage,
  SCHEMA_CHANGED_EVENT,
} from '../../lib/runtime/index.js';
import { __sweepIdle } from '../../lib/tenancy/index.js';
import { _wsPermCacheForTests, SCHEMA_CHANNEL, websocketHandler } from '../../routes/ws.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
  wsUpgradeData,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TAG = Date.now();
const COLLECTION = `wsschema_${TAG}`;
const SECOND = `wsschema2_${TAG}`;
const THIRD = `wsschema3_${TAG}`;
const FOURTH = `wsschema4_${TAG}`;
const FIFTH = `wsschema5_${TAG}`;
const OTHER = '00000000-0000-0000-0000-0000000000e7';
const OTHER_SLUG = `wsschema-other-${TAG}`;

d('schema events on the realtime socket', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  const probes: string[] = [];
  const keyIds: string[] = [];

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${OTHER}::uuid, ${OTHER_SLUG}, 'Other', 'active')
              ON CONFLICT (id) DO UPDATE SET slug = ${OTHER_SLUG}, status = 'active'`.execute(db);
  });

  afterAll(async () => {
    const { connections } = _wsPermCacheForTests();
    for (const id of probes) connections.delete(id);
    if (!db) return;
    if (keyIds.length > 0) await db.deleteFrom('zv_api_keys').where('id', 'in', keyIds).execute();
    for (const c of [COLLECTION, SECOND, THIRD, FOURTH, FIFTH])
      await dropTestCollection(db, c).catch(() => {});
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER}::uuid`.execute(db).catch(() => {});
  });

  /** A socket through the real upgrade, subscribed (or refused) to the schema channel. */
  async function openSchemaWs(headers: Record<string, string>) {
    const data = await wsUpgradeData(app, headers);
    const sent: string[] = [];
    let closed: number | null = null;
    const isOpen = () => _wsPermCacheForTests().connections.has(id);
    const none = { upgraded: false, sent, events: () => [] as SchemaEvent[], closed: () => closed };
    const id = `ws_schema_${probes.length}_${TAG}`;
    if (!data) return { ...none, isOpen };
    probes.push(id);
    const ws = {
      data: { ...data, id },
      send: (p: string) => sent.push(p),
      close: (code: number) => {
        closed = code;
      },
    };
    websocketHandler.open(ws as never);
    await websocketHandler.message(
      ws as never,
      JSON.stringify({ type: 'subscribe', channel: SCHEMA_CHANNEL }),
    );
    const events = () =>
      sent.map((f) => JSON.parse(f) as SchemaEvent).filter((m) => m.type === 'schema:changed');
    return { upgraded: true, sent, events, closed: () => closed, isOpen };
  }
  type SchemaEvent = { type: string; collection: string; action: string; timestamp: number };

  const ddl = (path: string, method: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function until(done: () => boolean) {
    for (let i = 0; i < 150 && !done(); i++) await Bun.sleep(20);
  }

  async function grantSchemaAdmin(userId: string, grant: boolean) {
    const res = await app.request('/api/permissions/roles', {
      method: grant ? 'POST' : 'DELETE',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({ userId, role: 'tenant_admin' }),
    });
    expect(res.status).toBe(200);
  }

  it('delivers create/alter/drop to schema admins on any host, and to nobody else', async () => {
    const admin = await createMemberSession(app, db);
    await grantSchemaAdmin(admin.userId, true);
    const member = await createMemberSession(app, db);

    const adminWs = await openSchemaWs({ cookie: admin.cookie });
    const memberWs = await openSchemaWs({ cookie: member.cookie });
    // A delegated tenant admin outside the root tenant may not alter collections…
    const otherAdminWs = await openSchemaWs({ cookie: admin.cookie, 'x-tenant-slug': OTHER_SLUG });
    // …but a god may from any host: collections are instance-wide, not per tenant.
    const otherGodWs = await openSchemaWs({ cookie: god, 'x-tenant-slug': OTHER_SLUG });

    expect(adminWs.sent.join('\n')).toContain(`"type":"subscribed","channel":"${SCHEMA_CHANNEL}"`);
    expect(memberWs.sent.join('\n')).toContain('"type":"error"');
    expect(memberWs.sent.join('\n')).not.toContain('"subscribed"');
    if (otherAdminWs.upgraded) expect(otherAdminWs.sent.join('\n')).not.toContain('"subscribed"');
    expect(otherGodWs.sent.join('\n')).toContain('"subscribed"');

    const create = await ddl('/api/collections', 'POST', {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    });
    expect(create.status).toBe(202);
    const alter = await ddl(`/api/collections/${COLLECTION}/fields`, 'POST', {
      name: 'secret_field_name',
      type: 'text',
      required: false,
      unique: false,
      indexed: false,
    });
    expect(alter.status).toBe(200);
    const drop = await ddl(`/api/collections/${COLLECTION}`, 'DELETE');
    expect(drop.status).toBe(200);

    await until(() => adminWs.events().length >= 3);
    const mine = adminWs.events().filter((e) => e.collection === COLLECTION);
    expect(mine.map((e) => e.action)).toEqual(['create', 'alter', 'drop']);
    // The name and the verb, never the definition.
    for (const e of mine)
      expect(Object.keys(e).sort()).toEqual(['action', 'collection', 'timestamp', 'type']);
    expect(adminWs.sent.join('')).not.toContain('secret_field_name');

    await until(() => otherGodWs.events().some((e) => e.action === 'drop'));
    expect(
      otherGodWs
        .events()
        .filter((e) => e.collection === COLLECTION)
        .map((e) => e.action),
    ).toEqual(['create', 'alter', 'drop']);
    for (const other of [memberWs, otherAdminWs]) {
      expect(other.events()).toEqual([]);
    }
  }, 60_000);

  it('stops delivering once the schema-admin right is revoked', async () => {
    const admin = await createMemberSession(app, db);
    await grantSchemaAdmin(admin.userId, true);
    const adminWs = await openSchemaWs({ cookie: admin.cookie });
    const godWs = await openSchemaWs({ cookie: god });
    expect(adminWs.sent.join('\n')).toContain('"subscribed"');

    await grantSchemaAdmin(admin.userId, false);
    await until(() => adminWs.sent.some((f) => f.includes('"unsubscribed"')));
    await __sweepIdle();
    expect(
      adminWs.sent.some((f) => f.includes('"unsubscribed"') && f.includes('"forbidden"')),
    ).toBe(true);

    const create = await ddl('/api/collections', 'POST', {
      name: SECOND,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    });
    expect(create.status).toBe(202);
    await until(() => godWs.events().some((e) => e.collection === SECOND));
    // The control: the event was published, and a schema admin still hears it.
    expect(godWs.events().some((e) => e.collection === SECOND && e.action === 'create')).toBe(true);
    expect(adminWs.events().filter((e) => e.collection === SECOND)).toEqual([]);
  }, 60_000);

  /** The SDK's watchSchema against a real server: initial generation, then one DDL event. */
  async function watchAndCreate(
    auth: { headers: Record<string, string> } | { apiKey: string },
    authType: 'session' | 'api_key',
    collection: string,
  ) {
    const server = Bun.serve({
      port: 0,
      fetch: (req, srv) => app.fetch(req, { server: srv }),
      websocket: websocketHandler,
    });
    const out = `${tmpdir()}/zv-watch-schema-${collection}.d.ts`;
    const updates: string[][] = [];
    const errors: string[] = [];
    const quiet = console.log;
    console.log = () => {};
    const stop = await watchSchema(`http://127.0.0.1:${server.port}`, out, {
      ...auth,
      onUpdate: (cols) => updates.push(cols.map((c) => c.name)),
      onError: (e) => errors.push(e.message),
    });
    try {
      expect(errors).toEqual([]);
      expect(updates.length).toBe(1); // the initial generation
      // Wait until the subscribe is registered, then change a collection.
      const subscribed = () =>
        [
          ...(_wsPermCacheForTests().connections.values() as Iterable<{
            subscriptions: Set<string>;
            authType: string;
          }>),
        ].some(
          (c) => c.subscriptions.has(SCHEMA_CHANNEL) && c.authType === authType && !probesHave(c),
        );
      await until(subscribed);
      expect(subscribed()).toBe(true);
      const res = await ddl('/api/collections', 'POST', {
        name: collection,
        fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
      });
      expect(res.status).toBe(202);
      await until(() => updates.length >= 2);
      expect(updates.length).toBe(2);
      expect(updates[1]).toContain(collection);
      expect(errors).toEqual([]);
    } finally {
      stop();
      console.log = quiet;
      server.stop(true);
      await rm(out, { force: true });
    }
  }

  it("fires the SDK's watchSchema over a real socket", async () => {
    await watchAndCreate({ headers: { cookie: god } }, 'session', THIRD);
  }, 60_000);

  async function createKey(scopes: Array<{ collection: string; actions: string[] }>) {
    const res = await app.request('/api/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({ name: `schema watcher ${Date.now()}`, scopes }),
    });
    expect(res.status).toBe(200);
    const key = (await res.json()) as { id: string; key: string };
    keyIds.push(key.id);
    return key;
  }
  const WATCH = [{ collection: SCHEMA_CHANNEL, actions: ['read'] }];
  const asKey = (key: string, path: string, method = 'GET', body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('a key with the explicit $schema scope reads the schema and hears its events', async () => {
    const { key } = await createKey(WATCH);
    const list = await asKey(key, '/api/collections');
    expect(list.status).toBe(200);
    expect(((await list.json()) as { collections: unknown[] }).collections.length).toBeGreaterThan(
      0,
    );
    const one = await asKey(key, '/api/collections/user');
    expect(one.status).toBe(200);

    const keyWs = await openSchemaWs({ 'X-API-Key': key });
    expect(keyWs.sent.join('\n')).toContain(`"type":"subscribed","channel":"${SCHEMA_CHANNEL}"`);
    const res = await ddl('/api/collections', 'POST', {
      name: FOURTH,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    });
    expect(res.status).toBe(202);
    await until(() => keyWs.events().some((e) => e.collection === FOURTH));
    expect(keyWs.events().filter((e) => e.collection === FOURTH)).toMatchObject([
      { action: 'create' },
    ]);
  }, 60_000);

  it('the $schema scope grants nothing else on /api/collections', async () => {
    const { key } = await createKey(WATCH);
    const field = { name: 'nope', type: 'text', required: false, unique: false, indexed: false };
    const refused = [
      await asKey(key, '/api/collections', 'POST', { name: `wsschema_nope_${TAG}`, fields: [] }),
      await asKey(key, '/api/collections/user', 'PATCH', { displayName: 'Nope' }),
      await asKey(key, `/api/collections/${FOURTH}`, 'DELETE'),
      await asKey(key, `/api/collections/${FOURTH}/fields`, 'POST', field),
      await asKey(key, '/api/collections/preview', 'POST', { name: 'nope', fields: [] }),
      await asKey(key, '/api/collections/field-types'),
      await asKey(key, '/api/collections/jobs/00000000-0000-0000-0000-000000000000'),
    ];
    for (const r of refused) expect([401, 403]).toContain(r.status);
    // The collection the DELETE named is still there.
    const still = await ddl(`/api/collections/${FOURTH}`, 'GET');
    expect(still.status).toBe(200);
  }, 60_000);

  it('a wildcard scope does not imply $schema, and the scope works only in the root tenant', async () => {
    for (const scopes of [
      [{ collection: '*', actions: ['read'] }],
      [{ collection: '*', actions: ['*'] }],
      [{ collection: SCHEMA_CHANNEL, actions: ['create', 'update', 'delete'] }],
    ]) {
      const { key } = await createKey(scopes);
      expect([401, 403]).toContain((await asKey(key, '/api/collections')).status);
      const ws = await openSchemaWs({ 'X-API-Key': key });
      expect(ws.upgraded).toBe(true);
      expect(ws.sent.join('\n')).not.toContain('"subscribed"');
    }
    // A root key acts in every tenant, but the schema is read from the root one — as
    // `requireInstanceAdmin` admits a root admin only there.
    const { key } = await createKey(WATCH);
    const viaOther = await app.request('/api/collections', {
      headers: { 'X-API-Key': key, 'x-tenant-slug': OTHER_SLUG },
    });
    expect([401, 403]).toContain(viaOther.status);
    const ws = await openSchemaWs({ 'X-API-Key': key, 'x-tenant-slug': OTHER_SLUG });
    expect(ws.upgraded).toBe(true);
    expect(ws.sent.join('\n')).not.toContain('"subscribed"');
  }, 60_000);

  it('revoking the key closes its schema socket; dropping the scope unsubscribes it', async () => {
    const revoked = await createKey(WATCH);
    const narrowed = await createKey(WATCH);
    const revokedWs = await openSchemaWs({ 'X-API-Key': revoked.key });
    const narrowedWs = await openSchemaWs({ 'X-API-Key': narrowed.key });
    expect(revokedWs.sent.join('\n')).toContain('"subscribed"');
    expect(narrowedWs.sent.join('\n')).toContain('"subscribed"');

    const del = await app.request(`/api/api-keys/${revoked.id}`, {
      method: 'DELETE',
      headers: { cookie: god },
    });
    expect(del.status).toBe(200);
    const patch = await app.request(`/api/admin/api-keys/${narrowed.id}`, {
      method: 'PATCH',
      headers: { cookie: god, 'content-type': 'application/json' },
      body: JSON.stringify({ scopes: [{ collection: '*', actions: ['read'] }] }),
    });
    expect(patch.status).toBe(200);
    await until(
      () =>
        revokedWs.closed() !== null && narrowedWs.sent.some((f) => f.includes('"unsubscribed"')),
    );
    await __sweepIdle();
    expect(revokedWs.closed()).toBe(4001);
    expect(revokedWs.isOpen()).toBe(false);
    expect(
      narrowedWs.sent.some((f) => f.includes('"unsubscribed"') && f.includes('"forbidden"')),
    ).toBe(true);
    expect(narrowedWs.isOpen()).toBe(true);
    const narrowedKey = await asKey(narrowed.key, '/api/collections');
    expect([401, 403]).toContain(narrowedKey.status);
  }, 60_000);

  it("fires the SDK's watchSchema with a $schema-scoped API key", async () => {
    const { key } = await createKey(WATCH);
    await watchAndCreate({ apiKey: key }, 'api_key', FIFTH);
  }, 60_000);

  it('crosses replicas on the realtime bus, to every schema watcher whatever its host', async () => {
    const godWs = await openSchemaWs({ cookie: god });
    const otherGodWs = await openSchemaWs({ cookie: god, 'x-tenant-slug': OTHER_SLUG });

    // Out: the announcing replica publishes it, with its tenant.
    const bus = realtimeBus();
    const published: Array<Omit<RealtimeBusMessage, 'originId'>> = [];
    const publish = bus.publish;
    bus.publish = async (m) => {
      published.push(m);
    };
    try {
      const res = await ddl(`/api/collections/${THIRD}`, 'PATCH', { displayName: 'Renamed' });
      expect(res.status).toBe(200);
      await until(() => published.some((m) => m.event === SCHEMA_CHANGED_EVENT));
    } finally {
      bus.publish = publish;
    }
    expect(published.find((m) => m.event === SCHEMA_CHANGED_EVENT)).toMatchObject({
      collection: THIRD,
      data: { action: 'alter' },
    });

    // In: another replica's announcement reaches this one's watchers, whichever tenant
    // the announcing request ran in.
    godWs.sent.length = 0;
    otherGodWs.sent.length = 0;
    await dispatchToWs({
      originId: 'eng-elsewhere',
      event: SCHEMA_CHANGED_EVENT,
      collection: 'from_elsewhere',
      data: { action: 'drop' },
      timestamp: new Date().toISOString(),
      tenantId: OTHER,
    });
    expect(godWs.events()).toMatchObject([{ collection: 'from_elsewhere', action: 'drop' }]);
    expect(otherGodWs.events()).toMatchObject([{ collection: 'from_elsewhere', action: 'drop' }]);
  }, 60_000);

  /** True for the probe sockets this file opened — the SDK's is the other one. */
  function probesHave(conn: object): boolean {
    const { connections } = _wsPermCacheForTests();
    return probes.some((id) => connections.get(id) === conn);
  }
});
