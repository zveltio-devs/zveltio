/**
 * `ctx.broadcast`: an extension's own message reaches every replica.
 *
 * `ai` caches each firm's providers and dropped the cache only on the replica
 * that saved the change; every other replica kept the old providers until it
 * restarted, and extensions had no way onto the realtime bus to say so.
 *
 * Both replicas play in one process, as `rate-limit-config-propagation` does:
 * the publish is captured off the bus, and a message from another replica is
 * delivered through `dispatchToWs`, as the Valkey / pg_notify subscriber does.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { buildRestrictedContext } from '../../lib/extensions/register.js';
import type { ExtensionContext } from '../../lib/extensions/internals.js';
import { clearExtensionBroadcasts, extensionBroadcast } from '../../lib/extensions/index.js';
import {
  _internalForTests,
  dispatchToWs,
  EXTENSION_BROADCAST_EVENT,
  POLICY_CHANGED_EVENT,
  realtimeBus,
  type RealtimeBusMessage,
} from '../../lib/runtime/index.js';
import { getCurrentTrxTenant, withTenantIsolation } from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const FIRM = '00000000-0000-4000-8000-0000000b0a01';

d('ctx.broadcast: an extension’s message reaches every replica, as its own', () => {
  let db: Database;
  const bus = realtimeBus();
  const origPublish = bus.publish;
  const sent: Array<Omit<RealtimeBusMessage, 'originId'>> = [];
  /** What a handler saw: its data, and the tenant transaction it ran in. */
  const heard: Array<{ ext: string; data: unknown; tenant: string | null }> = [];
  const listen = (ext: string, name: string) =>
    extensionBroadcast(ext).on(name, (data) => {
      heard.push({ ext, data, tenant: getCurrentTrxTenant() });
    });
  const fromPeer = (msg: Omit<RealtimeBusMessage, 'originId' | 'timestamp'>) =>
    dispatchToWs({ ...msg, originId: 'eng-peer', timestamp: new Date().toISOString() });
  const settle = async (n: number) => {
    for (let i = 0; i < 100 && heard.length < n; i++) await Bun.sleep(10);
  };

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${FIRM}, 'broadcast-firm', 'broadcast-firm', 'active')
              ON CONFLICT (id) DO NOTHING`.execute(db);
    bus.publish = async (payload) => {
      sent.push(payload);
    };
  });

  afterAll(async () => {
    bus.publish = origPublish;
    for (const ext of ['ext-a', 'ext-b']) clearExtensionBroadcasts(ext);
    await sql`DELETE FROM zv_tenants WHERE id = ${FIRM}`.execute(db);
  });

  it('a message from another replica runs the handler in the sender’s tenant', async () => {
    heard.length = 0;
    clearExtensionBroadcasts('ext-a');
    listen('ext-a', 'cache.drop');
    await fromPeer({
      event: EXTENSION_BROADCAST_EVENT,
      collection: 'ext-a',
      data: { name: 'cache.drop', data: { id: 7 } },
      tenantId: FIRM,
    });
    expect(heard).toEqual([{ ext: 'ext-a', data: { id: 7 }, tenant: FIRM }]);
  });

  it('a publish goes on the bus after the commit, and reaches this replica too', async () => {
    heard.length = 0;
    sent.length = 0;
    clearExtensionBroadcasts('ext-a');
    listen('ext-a', 'cache.drop');
    await withTenantIsolation(FIRM, async () => {
      await extensionBroadcast('ext-a').publish('cache.drop', { id: 8, at: new Date(0) });
      // Not before the commit: a replica re-reading now would cache the old rows.
      expect(sent).toHaveLength(0);
      expect(heard).toHaveLength(0);
    });
    await settle(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      event: EXTENSION_BROADCAST_EVENT,
      collection: 'ext-a',
      tenantId: FIRM,
      data: { name: 'cache.drop', data: { id: 8, at: new Date(0) } },
    });
    // Here as on any other replica: after a JSON round trip.
    expect(heard).toEqual([
      { ext: 'ext-a', data: { id: 8, at: '1970-01-01T00:00:00.000Z' }, tenant: FIRM },
    ]);
  });

  it('a rolled-back publish is sent nowhere', async () => {
    heard.length = 0;
    sent.length = 0;
    await withTenantIsolation(FIRM, async () => {
      await extensionBroadcast('ext-a').publish('cache.drop', { id: 9 });
      throw new Error('roll back');
    }).catch(() => undefined);
    await Bun.sleep(50);
    expect(sent).toHaveLength(0);
    expect(heard).toHaveLength(0);
  });

  it('an extension speaks only for itself, never for the engine or another extension', async () => {
    heard.length = 0;
    sent.length = 0;
    clearExtensionBroadcasts('ext-a');
    listen('ext-a', 'cache.drop');
    listen('ext-a', POLICY_CHANGED_EVENT);
    // ext-b names ext-a's message and an engine event: both go out as ext-b's.
    await extensionBroadcast('ext-b').publish('cache.drop', { forged: true });
    await extensionBroadcast('ext-b').publish(POLICY_CHANGED_EVENT, { forged: true });
    await Bun.sleep(20);
    expect(sent.map((m) => [m.event, m.collection])).toEqual([
      [EXTENSION_BROADCAST_EVENT, 'ext-b'],
      [EXTENSION_BROADCAST_EVENT, 'ext-b'],
    ]);
    // Delivered on another replica, they reach ext-b's handlers only — it has none.
    for (const m of sent) await fromPeer(m);
    // An engine event is not an extension's message, whatever its name.
    await fromPeer({ event: 'cache.drop', collection: 'ext-a', data: { name: 'cache.drop' } });
    expect(heard).toEqual([]);
  });

  it('refuses an oversized message and a malformed name at publish', async () => {
    sent.length = 0;
    const b = extensionBroadcast('ext-a');
    await expect(b.publish('big', 'ă'.repeat(4000))).rejects.toThrow(/bytes encoded, over the/);
    await expect(b.publish('', null)).rejects.toThrow(/must match/);
    await expect(b.publish('a b', null)).rejects.toThrow(/must match/);
    expect(() => b.on('x'.repeat(65), () => undefined)).toThrow(/must match/);
    await Bun.sleep(20);
    expect(sent).toHaveLength(0);
  });

  it('the context the engine hands an extension carries it, and a reload drops old handlers', async () => {
    heard.length = 0;
    clearExtensionBroadcasts('ext-a');
    listen('ext-a', 'cache.drop');
    const ctx = buildRestrictedContext(
      { db } as unknown as ExtensionContext,
      'ext-a',
      new Hono(),
      undefined,
      false,
    );
    await fromPeer({
      event: EXTENSION_BROADCAST_EVENT,
      collection: 'ext-a',
      data: { name: 'cache.drop', data: 1 },
      tenantId: null,
    });
    expect(heard).toEqual([]);
    ctx.broadcast?.on('cache.drop', (data) => {
      heard.push({ ext: 'ctx', data, tenant: getCurrentTrxTenant() });
    });
    await fromPeer({
      event: EXTENSION_BROADCAST_EVENT,
      collection: 'ext-a',
      data: { name: 'cache.drop', data: 2 },
      tenantId: null,
    });
    expect(heard).toEqual([{ ext: 'ctx', data: 2, tenant: null }]);
  });

  it('a bus reconnect tells each extension it may have missed messages', async () => {
    let missed = 0;
    extensionBroadcast('ext-b').onMissed(() => {
      missed++;
    });
    _internalForTests.onBusReconnected();
    for (let i = 0; i < 100 && missed === 0; i++) await Bun.sleep(10);
    expect(missed).toBe(1);
  });
});
