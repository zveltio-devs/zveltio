/**
 * WS permission cache invalidation — role changes must clear subscribe decisions.
 */

import { describe, expect, it } from 'bun:test';
import { invalidateWsUserPermCache, _wsPermCacheForTests } from '../../routes/ws.js';

describe('invalidateWsUserPermCache', () => {
  it('clears the per-socket perm map for matching userId', () => {
    const { wsPermCache, connections } = _wsPermCacheForTests();
    const ws = {};
    const connId = 'test-conn-ws-perm';
    connections.set(connId, {
      userId: 'user-a',
      tenantId: null,
      ws,
      subscriptions: new Set(),
      connectedAt: Date.now(),
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
      tenantId: null,
      ws: wsA,
      subscriptions: new Set(),
      connectedAt: Date.now(),
    });
    connections.set('b', {
      userId: 'user-b',
      tenantId: null,
      ws: wsB,
      subscriptions: new Set(),
      connectedAt: Date.now(),
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
