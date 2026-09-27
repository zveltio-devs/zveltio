/**
 * Schema (DDL) events on the realtime socket.
 *
 * The SDK's `watchSchema` subscribed to a schema channel the engine never
 * published on, so it never fired. Now a collection's create/alter/drop is
 * announced after it lands, on `SCHEMA_CHANNEL`, to whoever may alter
 * collections — the collections routes' own gate, `requireInstanceAdmin`, asked
 * in the socket's tenant — and to nobody else.
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
const OTHER = '00000000-0000-0000-0000-0000000000e7';
const OTHER_SLUG = `wsschema-other-${TAG}`;

d('schema events on the realtime socket', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  const probes: string[] = [];

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
    for (const c of [COLLECTION, SECOND, THIRD]) await dropTestCollection(db, c).catch(() => {});
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER}::uuid`.execute(db).catch(() => {});
  });

  /** A socket through the real upgrade, subscribed (or refused) to the schema channel. */
  async function openSchemaWs(headers: Record<string, string>) {
    const data = await wsUpgradeData(app, headers);
    const sent: string[] = [];
    if (!data) return { upgraded: false, sent, events: () => [] as SchemaEvent[] };
    const id = `ws_schema_${probes.length}_${TAG}`;
    probes.push(id);
    const ws = { data: { ...data, id }, send: (p: string) => sent.push(p), close: () => {} };
    websocketHandler.open(ws as never);
    await websocketHandler.message(
      ws as never,
      JSON.stringify({ type: 'subscribe', channel: SCHEMA_CHANNEL }),
    );
    const events = () =>
      sent.map((f) => JSON.parse(f) as SchemaEvent).filter((m) => m.type === 'schema:changed');
    return { upgraded: true, sent, events };
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

  it('delivers create/alter/drop to a schema admin of the tenant, and to nobody else', async () => {
    const admin = await createMemberSession(app, db);
    await grantSchemaAdmin(admin.userId, true);
    const member = await createMemberSession(app, db);

    const adminWs = await openSchemaWs({ cookie: admin.cookie });
    const memberWs = await openSchemaWs({ cookie: member.cookie });
    // A delegated tenant admin outside the root tenant may not alter collections…
    const otherAdminWs = await openSchemaWs({ cookie: admin.cookie, 'x-tenant-slug': OTHER_SLUG });
    // …and a god who may, but opened the socket in another tenant, hears only that tenant.
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

    for (const other of [memberWs, otherAdminWs, otherGodWs]) {
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

  it("fires the SDK's watchSchema over a real socket", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (req, srv) => app.fetch(req, { server: srv }),
      websocket: websocketHandler,
    });
    const out = `${tmpdir()}/zv-watch-schema-${TAG}.d.ts`;
    const updates: string[][] = [];
    const errors: string[] = [];
    const quiet = console.log;
    console.log = () => {};
    const stop = await watchSchema(`http://127.0.0.1:${server.port}`, out, {
      headers: { cookie: god },
      onUpdate: (cols) => updates.push(cols.map((c) => c.name)),
      onError: (e) => errors.push(e.message),
    });
    try {
      expect(updates.length).toBe(1); // the initial generation
      // Wait until the subscribe is registered, then change a collection.
      const subscribed = () =>
        [
          ...(_wsPermCacheForTests().connections.values() as Iterable<{
            subscriptions: Set<string>;
          }>),
        ].some((c) => c.subscriptions.has(SCHEMA_CHANNEL) && !probesHave(c));
      await until(subscribed);
      expect(subscribed()).toBe(true);
      const res = await ddl('/api/collections', 'POST', {
        name: THIRD,
        fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
      });
      expect(res.status).toBe(202);
      await until(() => updates.length >= 2);
      expect(updates.length).toBe(2);
      expect(updates[1]).toContain(THIRD);
      expect(errors).toEqual([]);
    } finally {
      stop();
      console.log = quiet;
      server.stop(true);
      await rm(out, { force: true });
    }
  }, 60_000);

  it('crosses replicas on the realtime bus, and a received event stays in its tenant', async () => {
    const TENANT = '00000000-0000-0000-0000-000000000001';
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
      tenantId: TENANT,
    });

    // In: another replica's announcement reaches this one's admins in that tenant only.
    godWs.sent.length = 0;
    await dispatchToWs({
      originId: 'eng-elsewhere',
      event: SCHEMA_CHANGED_EVENT,
      collection: 'from_elsewhere',
      data: { action: 'drop' },
      timestamp: new Date().toISOString(),
      tenantId: TENANT,
    });
    expect(godWs.events()).toMatchObject([{ collection: 'from_elsewhere', action: 'drop' }]);
    expect(otherGodWs.events().filter((e) => e.collection === 'from_elsewhere')).toEqual([]);
  }, 60_000);

  /** True for the probe sockets this file opened — the SDK's is the other one. */
  function probesHave(conn: object): boolean {
    const { connections } = _wsPermCacheForTests();
    return probes.some((id) => connections.get(id) === conn);
  }
});
