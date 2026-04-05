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

// Active SSE connections: userId → Set of SSE writers
const connections = new Map<string, Set<any>>();

// Broadcast an event to all connected SSE clients
export function broadcastSSE(channel: string, event: string, data: any): void {
  const payload = JSON.stringify({
    channel,
    event,
    data,
    timestamp: new Date().toISOString(),
  });

  for (const [, writers] of connections) {
    for (const writer of writers) {
      try {
        writer.writeSSE({ data: payload, event });
      } catch {
        /* client disconnected */
      }
    }
  }
}

export function realtimeRoutes(_db: Database, _auth: any): Hono {
  const app = new Hono();

  // GET /stream — SSE endpoint for real-time updates
  app.get('/stream', async (c) => {
    // Auth via session (SSE doesn't support custom headers from EventSource — use cookie)
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    const userId = session.user.id;
    const collections =
      c.req.query('collection')?.split(',').filter(Boolean) ?? [];

    return streamSSE(c, async (stream) => {
      // Register this connection
      if (!connections.has(userId)) connections.set(userId, new Set());
      const userConnections = connections.get(userId)!;
      userConnections.add(stream);

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
              stream.writeSSE({ data: message, event: 'data' });
            } catch {
              /* stream closed */
            }
          });
        } catch {
          /* Redis unavailable — SSE still works without Redis */
        }
      }

      // Send connection confirmation
      await stream.writeSSE({
        data: JSON.stringify({
          type: 'connected',
          userId,
          collections,
          timestamp: new Date().toISOString(),
        }),
        event: 'connected',
      });

      // Keep alive ping every 30s
      const pingInterval = setInterval(() => {
        // Errors here are handled by onAbort — do not clear interval inside catch
        // because onAbort is the authoritative cleanup path.
        stream.writeSSE({ data: 'ping', event: 'ping' }).catch(() => {});
      }, 30_000);

      // Cleanup on disconnect — single onAbort handler; also resolves the promise
      // that keeps this streamSSE callback alive.
      await new Promise<void>((resolve) => {
        stream.onAbort(async () => {
          clearInterval(pingInterval);
          userConnections.delete(stream);
          if (userConnections.size === 0) connections.delete(userId);
          if (subscriber) {
            try {
              await subscriber.unsubscribe();
              await subscriber.disconnect();
            } catch {
              /* ignore */
            }
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

    // Optionally also publish to cache so other instances receive the event
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
      } catch {
        /* non-fatal */
      }
    }

    // Broadcast directly to in-process SSE clients
    broadcastSSE(body.channel, body.event ?? 'message', body.payload);

    return c.json({ success: true });
  });

  return app;
}
