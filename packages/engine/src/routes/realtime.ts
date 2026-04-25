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

// ── Presence ──────────────────────────────────────────────────────────────────
// In-memory fallback when Valkey is unavailable: channel → Map<userId, lastSeen>
const presenceStore = new Map<string, Map<string, number>>();
const PRESENCE_TTL_MS = 60_000; // consider user offline after 60s without heartbeat

function presenceCleanup(channel: string) {
  const members = presenceStore.get(channel);
  if (!members) return;
  const cutoff = Date.now() - PRESENCE_TTL_MS;
  for (const [uid, ts] of members) {
    if (ts < cutoff) members.delete(uid);
  }
  if (members.size === 0) presenceStore.delete(channel);
}

async function presenceJoin(cache: any, channel: string, userId: string, meta: Record<string, any>) {
  const ts = Date.now();
  if (cache) {
    try {
      const key = `presence:${channel}`;
      await cache.zadd(key, ts, userId);
      await cache.pexpire(key, PRESENCE_TTL_MS * 2);
      // Store user meta as hash
      await cache.hset(`presence_meta:${channel}:${userId}`, meta);
      await cache.pexpire(`presence_meta:${channel}:${userId}`, PRESENCE_TTL_MS * 2);
      return;
    } catch { /* fall through to in-memory */ }
  }
  if (!presenceStore.has(channel)) presenceStore.set(channel, new Map());
  presenceStore.get(channel)!.set(userId, ts);
}

async function presenceLeave(cache: any, channel: string, userId: string) {
  if (cache) {
    try {
      await cache.zrem(`presence:${channel}`, userId);
      await cache.del(`presence_meta:${channel}:${userId}`);
      return;
    } catch { /* fall through */ }
  }
  presenceStore.get(channel)?.delete(userId);
}

async function presenceList(cache: any, channel: string): Promise<Array<{ userId: string; lastSeen: number }>> {
  const cutoff = Date.now() - PRESENCE_TTL_MS;
  if (cache) {
    try {
      const key = `presence:${channel}`;
      await cache.zremrangebyscore(key, 0, cutoff);
      const members: string[] = await cache.zrange(key, 0, -1, 'WITHSCORES');
      const result: Array<{ userId: string; lastSeen: number }> = [];
      for (let i = 0; i < members.length; i += 2) {
        result.push({ userId: members[i], lastSeen: parseInt(members[i + 1]) });
      }
      return result;
    } catch { /* fall through */ }
  }
  presenceCleanup(channel);
  const members = presenceStore.get(channel);
  if (!members) return [];
  return [...members.entries()].map(([userId, lastSeen]) => ({ userId, lastSeen }));
}

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
  //   ?collection=col1,col2          — subscribe to data collections (empty = all data)
  //   ?channel=broadcast:x,presence:y — subscribe to broadcast/presence channels
  //   ?record_id=uuid                — only events for this record
  //   ?filter={"field":"value"}      — field-level filter on record payload
  app.get('/stream', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    const userId = session.user.id;
    const collections = c.req.query('collection')?.split(',').filter(Boolean) ?? [];
    const extraChannels = c.req.query('channel')?.split(',').filter(Boolean).map((ch) =>
      ch.startsWith('zveltio:') ? ch : `zveltio:${ch}`,
    ) ?? [];
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
          const dataChannels =
            collections.length > 0
              ? collections.map((col) => `zveltio:data:${col}`)
              : [CHANNELS.DATA_CHANGES];
          const channels = [...dataChannels, ...extraChannels];

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
          channels: extraChannels,
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

  // ── Presence ───────────────────────────────────────────────────
  // POST /presence/:channel — Join a presence channel (or send heartbeat)
  app.post('/presence/:channel', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    const channel = c.req.param('channel');
    const meta = await c.req.json().catch(() => ({}));
    const cache = getCache();

    await presenceJoin(cache, channel, session.user.id, {
      name: session.user.name,
      email: session.user.email,
      ...meta,
    });

    // Broadcast join event to all channel subscribers
    broadcastSSE(`zveltio:presence:${channel}`, 'presence.join', {
      channel,
      userId: session.user.id,
      user: { name: session.user.name },
      timestamp: new Date().toISOString(),
    });
    if (cache) {
      try {
        await cache.publish(`zveltio:presence:${channel}`, JSON.stringify({
          event: 'presence.join',
          channel,
          userId: session.user.id,
          timestamp: Date.now(),
        }));
      } catch { /* non-fatal */ }
    }

    return c.json({ success: true, channel });
  });

  // DELETE /presence/:channel — Leave a presence channel
  app.delete('/presence/:channel', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    const channel = c.req.param('channel');
    const cache = getCache();

    await presenceLeave(cache, channel, session.user.id);

    broadcastSSE(`zveltio:presence:${channel}`, 'presence.leave', {
      channel,
      userId: session.user.id,
      timestamp: new Date().toISOString(),
    });
    if (cache) {
      try {
        await cache.publish(`zveltio:presence:${channel}`, JSON.stringify({
          event: 'presence.leave',
          channel,
          userId: session.user.id,
          timestamp: Date.now(),
        }));
      } catch { /* non-fatal */ }
    }

    return c.json({ success: true });
  });

  // GET /presence/:channel — List users in a channel
  app.get('/presence/:channel', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    const cache = getCache();
    const members = await presenceList(cache, c.req.param('channel'));
    return c.json({ channel: c.req.param('channel'), members });
  });

  // ── Broadcast channels ─────────────────────────────────────────
  // POST /broadcast/:channel — Publish a message to a custom channel
  // Any authenticated user can publish; clients subscribe via SSE ?channel=broadcast:name
  app.post('/broadcast/:channel', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    const channel = c.req.param('channel');
    if (channel.length > 128) return c.json({ error: 'Channel name too long' }, 400);

    const body = await c.req.json().catch(() => null);
    if (!body?.event || !body?.payload) {
      return c.json({ error: 'event and payload are required' }, 400);
    }

    const broadcastChannel = `zveltio:broadcast:${channel}`;
    const message = {
      channel: broadcastChannel,
      event: body.event,
      payload: body.payload,
      senderId: session.user.id,
      timestamp: new Date().toISOString(),
    };

    const cache = getCache();
    if (cache) {
      try {
        await cache.publish(broadcastChannel, JSON.stringify(message));
      } catch { /* non-fatal */ }
    }

    broadcastSSE(broadcastChannel, body.event, message);

    return c.json({ success: true, channel: broadcastChannel });
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
