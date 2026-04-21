import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Database } from '../db/index.js';
import { auth } from '../lib/auth.js';
import { checkPermission } from '../lib/permissions.js';
import { getCache } from '../lib/cache.js';

// Standard channel names (mirrors old-repo CHANNELS for SDK compatibility)
export const CHANNELS = {
  DATA_CHANGES: 'zveltio:data:*',
  NOTIFICATIONS: 'zveltio:notifications',
  SYSTEM: 'zveltio:system',
  PROACTIVE_AI_ALERTS: 'zveltio:ai:alerts',
  PROACTIVE_AI_SUGGESTIONS: 'zveltio:ai:suggestions',
} as const;

interface SubscriptionFilter {
  field: string;
  op: 'eq' | 'neq' | 'in';
  value: any;
}

interface StreamSub {
  stream: any;
  collections: string[];   // empty = all
  recordId?: string;       // filter to specific record ID
  filters: SubscriptionFilter[];  // field-level filters on the record payload
}

// Active SSE connections: userId → Set of subscriptions
const connections = new Map<string, Set<StreamSub>>();

function matchesSub(sub: StreamSub, collection: string, record: any): boolean {
  if (sub.collections.length > 0 && !sub.collections.includes(collection)) return false;
  if (sub.recordId && record?.id !== sub.recordId) return false;
  for (const f of sub.filters) {
    const val = record?.[f.field];
    if (f.op === 'eq' && val !== f.value) return false;
    if (f.op === 'neq' && val === f.value) return false;
    if (f.op === 'in' && (!Array.isArray(f.value) || !f.value.includes(val))) return false;
  }
  return true;
}

/** Broadcast a data event — applies per-subscription filtering before sending. */
export function broadcastDataEvent(collection: string, event: string, record: any): void {
  const payload = JSON.stringify({
    channel: `zveltio:data:${collection}`,
    event,
    collection,
    data: record,
    timestamp: new Date().toISOString(),
  });

  for (const [, subs] of connections) {
    for (const sub of subs) {
      if (!matchesSub(sub, collection, record)) continue;
      try {
        sub.stream.writeSSE({ data: payload, event: 'data' });
      } catch { /* client disconnected */ }
    }
  }
}

/** Broadcast a generic (non-data) event to all connected clients. */
export function broadcastSSE(channel: string, event: string, data: any): void {
  const payload = JSON.stringify({
    channel,
    event,
    data,
    timestamp: new Date().toISOString(),
  });

  for (const [, subs] of connections) {
    for (const sub of subs) {
      try {
        sub.stream.writeSSE({ data: payload, event });
      } catch { /* client disconnected */ }
    }
  }
}

/** Parse ?filter={"status":"published"} or ?filter={"price":{"gt":50}} into SubscriptionFilter[] */
function parseSubFilters(raw: string | undefined): SubscriptionFilter[] {
  if (!raw) return [];
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== 'object' || Array.isArray(obj)) return [];
    return Object.entries(obj).map(([field, value]) => {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const [op, val] = Object.entries(value)[0] as [string, any];
        const mappedOp = op === 'neq' ? 'neq' : op === 'in' ? 'in' : 'eq';
        return { field, op: mappedOp, value: val };
      }
      return { field, op: 'eq' as const, value };
    });
  } catch {
    return [];
  }
}

export function realtimeRoutes(_db: Database, _auth: any): Hono {
  const app = new Hono();

  // GET /stream — SSE endpoint for real-time updates
  // Query params:
  //   ?collection=col1,col2      — subscribe to specific collections (empty = all)
  //   ?record_id=uuid            — only events for this record
  //   ?filter={"field":"value"}  — field-level filter on record payload
  app.get('/stream', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    const userId = session.user.id;
    const collections = c.req.query('collection')?.split(',').filter(Boolean) ?? [];
    const recordId = c.req.query('record_id') || undefined;
    const filters = parseSubFilters(c.req.query('filter'));

    return streamSSE(c, async (stream) => {
      const sub: StreamSub = { stream, collections, recordId, filters };

      if (!connections.has(userId)) connections.set(userId, new Set());
      const userSubs = connections.get(userId)!;
      userSubs.add(sub);

      // Subscribe to cache channels if cache is available
      const cache = getCache();
      let subscriber: any = null;

      if (cache) {
        try {
          subscriber = cache.duplicate();
          const channels =
            collections.length > 0
              ? collections.map((col) => `zveltio:data:${col}`)
              : [CHANNELS.DATA_CHANGES];

          await subscriber.subscribe(...channels);

          subscriber.on('message', (_channel: string, message: string) => {
            try {
              // Per-record / per-filter: parse message and check before forwarding
              if (recordId || filters.length > 0) {
                const parsed = JSON.parse(message);
                const col = parsed?.collection ?? _channel.replace('zveltio:data:', '');
                if (!matchesSub(sub, col, parsed?.data ?? parsed)) return;
              }
              stream.writeSSE({ data: message, event: 'data' });
            } catch { /* stream closed or malformed message */ }
          });
        } catch {
          /* Redis unavailable — in-process broadcastDataEvent still works */
        }
      }

      await stream.writeSSE({
        data: JSON.stringify({
          type: 'connected',
          userId,
          collections,
          record_id: recordId ?? null,
          filters,
          timestamp: new Date().toISOString(),
        }),
        event: 'connected',
      });

      const pingInterval = setInterval(() => {
        stream.writeSSE({ data: 'ping', event: 'ping' }).catch(() => {});
      }, 30_000);

      await new Promise<void>((resolve) => {
        stream.onAbort(async () => {
          clearInterval(pingInterval);
          userSubs.delete(sub);
          if (userSubs.size === 0) connections.delete(userId);
          if (subscriber) {
            try {
              await subscriber.unsubscribe();
              await subscriber.disconnect();
            } catch { /* ignore */ }
          }
          resolve();
        });
      });
    });
  });

  // GET /connections — Admin: list active SSE connections
  app.get('/connections', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    return c.json({
      connections: connections.size,
      users: [...connections.keys()].map((id) => ({
        userId: id,
        streams: connections.get(id)?.size ?? 0,
      })),
    });
  });

  // POST /publish — Admin: publish a custom event to all SSE clients
  app.post('/publish', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    const isAdmin = await checkPermission(session.user.id, 'admin', '*');
    if (!isAdmin) return c.json({ error: 'Admin access required' }, 403);

    const body = await c.req.json().catch(() => null);
    if (!body?.channel || !body?.payload) {
      return c.json({ error: 'channel and payload are required' }, 400);
    }

    const cache = getCache();
    if (cache) {
      try {
        await cache.publish(
          body.channel,
          JSON.stringify({
            payload: body.payload,
            userId: session.user.id,
            timestamp: Date.now(),
          }),
        );
      } catch { /* non-fatal */ }
    }

    broadcastSSE(body.channel, body.event ?? 'message', body.payload);

    return c.json({ success: true });
  });

  return app;
}
