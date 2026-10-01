/**
 * WS permission cache — any policy change must void cached subscribe decisions.
 */

import { describe, expect, it } from 'bun:test';
import { clearLocalPermissionCache, permissionGeneration } from '../../lib/tenancy/index.js';
import {
  broadcastEvent,
  websocketHandler,
  wsRoutes,
  _wsPermCacheForTests,
} from '../../routes/ws.js';
import type { ReadScope } from '../../lib/data/read-scope.js';

/** A read gate that admits every row and hides no column. */
const openScope = (table: string): ReadScope => ({
  table,
  rls: [],
  columns: { hidden: new Set(), readOnly: new Set() },
  altersRestrict: false,
  query: (qb) => qb,
  keep: async (rows) => rows,
  admits: () => true,
  shape: (row) => row,
  readable: () => true,
});

describe('WS subscribe decisions', () => {
  // It used to be cleared only for the subject of a role-link change on a
  // receiving instance: a revoked RULE, or any change on the instance that made
  // it, kept a cached `allowed` answering for up to the 60 s TTL.
  it('are re-evaluated after any policy change, whoever it touched', async () => {
    // No database handle, whatever an earlier file in this process mounted: a
    // fresh check then answers `false` without throwing and files a NEW entry.
    // The test used to rely on a handle left behind by another file — alone, or
    // in another order, the cached `allowed` path failed on the access lookup.
    wsRoutes(undefined as never, {} as never);
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
      principal: { kind: 'session' as const, token: 't', userId: 'user-a' },
      access: new Map([['contacts', openScope('contacts')]]),
    });
    try {
      const cached = { allowed: false, checkedAt: Date.now(), gen: permissionGeneration() };
      const perms = new Map([['contacts', cached]]);
      wsPermCache.set(ws, perms);
      const subscribe = () =>
        websocketHandler.message(
          ws as never,
          JSON.stringify({ type: 'subscribe', collections: ['contacts'] }),
        );

      await subscribe();
      expect(JSON.parse(sent.pop()!).denied).toEqual(['contacts']);
      // Same generation, inside the TTL: the cached decision answered.
      expect(perms.get('contacts')).toBe(cached);

      clearLocalPermissionCache(); // what every policy change does
      await subscribe();
      // A new generation: the cached decision was not trusted, the check ran again.
      expect(perms.get('contacts')).not.toBe(cached);
      expect(perms.get('contacts')?.gen).toBe(permissionGeneration());
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
      principal: { kind: 'session' as const, token: 't', userId: 'user-a' },
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
    const access = new Map([['contacts', openScope('contacts')]]);
    expect(deliveredTo(access).join('')).toContain('"c-1"');
  });
});
