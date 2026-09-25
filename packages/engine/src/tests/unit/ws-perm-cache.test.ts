/**
 * WS permission cache invalidation — role changes must clear subscribe decisions.
 */

import { describe, expect, it } from 'bun:test';
import {
  broadcastEvent,
  invalidateWsUserPermCache,
  _wsPermCacheForTests,
} from '../../routes/ws.js';

describe('invalidateWsUserPermCache', () => {
  it('clears the per-socket perm map for matching userId', () => {
    const { wsPermCache, connections } = _wsPermCacheForTests();
    const ws = {};
    const connId = 'test-conn-ws-perm';
    connections.set(connId, {
      userId: 'user-a',
      user: { id: 'user-a' },
      tenantId: null,
      ws,
      subscriptions: new Set(),
      connectedAt: Date.now(),
      authType: 'session' as const,
      access: new Map(),
    });
    const map = new Map<string, { allowed: boolean; checkedAt: number }>();
    map.set('contacts', { allowed: true, checkedAt: Date.now() });
    wsPermCache.set(ws, map);

    invalidateWsUserPermCache('user-a');

    const after = wsPermCache.get(ws);
    expect(after).toBeDefined();
    expect(after!.size).toBe(0);

    connections.delete(connId);
  });

  it('does not clear caches for other users', () => {
    const { wsPermCache, connections } = _wsPermCacheForTests();
    const wsA = {};
    const wsB = {};
    connections.set('a', {
      userId: 'user-a',
      user: { id: 'user-a' },
      tenantId: null,
      ws: wsA,
      subscriptions: new Set(),
      connectedAt: Date.now(),
      authType: 'session' as const,
      access: new Map(),
    });
    connections.set('b', {
      userId: 'user-b',
      user: { id: 'user-b' },
      tenantId: null,
      ws: wsB,
      subscriptions: new Set(),
      connectedAt: Date.now(),
      authType: 'session' as const,
      access: new Map(),
    });
    const mapB = new Map([['orders', { allowed: true, checkedAt: Date.now() }]]);
    wsPermCache.set(wsA, new Map([['contacts', { allowed: true, checkedAt: Date.now() }]]));
    wsPermCache.set(wsB, mapB);

    invalidateWsUserPermCache('user-a');

    expect(wsPermCache.get(wsA)!.size).toBe(0);
    expect(wsPermCache.get(wsB)!.get('orders')?.allowed).toBe(true);

    connections.delete('a');
    connections.delete('b');
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
