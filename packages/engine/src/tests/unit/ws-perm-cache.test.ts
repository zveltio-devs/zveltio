/**
 * WS permission cache — any policy change must void cached subscribe decisions.
 */

import { describe, expect, it } from 'bun:test';
import { clearLocalPermissionCache, permissionGeneration } from '../../lib/tenancy/index.js';
import { broadcastEvent, websocketHandler, _wsPermCacheForTests } from '../../routes/ws.js';

describe('WS subscribe decisions', () => {
  // It used to be cleared only for the subject of a role-link change on a
  // receiving instance: a revoked RULE, or any change on the instance that made
  // it, kept a cached `allowed` answering for up to the 60 s TTL.
  it('are re-evaluated after any policy change, whoever it touched', async () => {
    const { wsPermCache, connections } = _wsPermCacheForTests();
    const sent: string[] = [];
    const ws = { data: { id: 'test-conn-gen' }, send: (p: string) => sent.push(p) };
    connections.set('test-conn-gen', {
      userId: 'user-a',
      user: { id: 'user-a' } as never,
      tenantId: null,
      ws,
      subscriptions: new Set(),
      connectedAt: Date.now(),
      authType: 'session' as const,
      access: new Map([['contacts', { rls: [], columns: null }]]),
    });
    try {
      wsPermCache.set(
        ws,
        new Map([
          ['contacts', { allowed: true, checkedAt: Date.now(), gen: permissionGeneration() }],
        ]),
      );
      const subscribe = () =>
        websocketHandler.message(
          ws as never,
          JSON.stringify({ type: 'subscribe', collections: ['contacts'] }),
        );

      await subscribe();
      expect(JSON.parse(sent.pop()!).collections).toEqual(['contacts']);

      clearLocalPermissionCache(); // what every policy change does
      await subscribe();
      // No routes mounted, so a fresh check has no database and refuses.
      expect(JSON.parse(sent.pop()!).denied).toEqual(['contacts']);
    } finally {
      connections.delete('test-conn-gen');
    }
  });
});

describe('broadcastEvent', () => {
  // A subscription whose access was never resolved has no row or column
  // filter to apply. The fan-out used to read that as "nothing to filter".
  function deliveredTo(access: Map<string, unknown>): string[] {
    const { connections, indexSubscription } = _wsPermCacheForTests();
    const sent: string[] = [];
    connections.set('ws-no-access', {
      userId: 'user-a',
      user: { id: 'user-a' } as never,
      tenantId: null,
      ws: { send: (p: string) => sent.push(p) } as never,
      subscriptions: new Set(['contacts']),
      connectedAt: Date.now(),
      authType: 'session' as const,
      access: access as never,
    });
    indexSubscription('contacts', 'ws-no-access');
    try {
      broadcastEvent('contacts', 'insert', { id: 'c-1' }, null);
    } finally {
      connections.delete('ws-no-access');
    }
    return sent;
  }

  it('delivers nothing to a subscription with no resolved access', () => {
    expect(deliveredTo(new Map())).toEqual([]);
  });

  it('delivers to a subscription whose access was resolved', () => {
    const access = new Map([['contacts', { rls: [], columns: null }]]);
    expect(deliveredTo(access).join('')).toContain('"c-1"');
  });
});
