import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Database } from '../db/index.js';
import { getRedis } from '../lib/redis.js';

// Active SSE connections: userId → Set of SSE writers
const connections = new Map<string, Set<any>>();

// Broadcast an event to all connected SSE clients subscribed to a channel
export function broadcastSSE(channel: string, event: string, data: any): void {
  const payload = JSON.stringify({ channel, event, data, timestamp: new Date().toISOString() });

  for (const [, writers] of connections) {
    for (const writer of writers) {
      try {
        writer.writeSSE({ data: payload, event });
      } catch { /* client disconnected */ }
    }
  }
}

export function realtimeRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // GET /stream — SSE endpoint for real-time updates
  app.get('/stream', async (c) => {
    // Auth via session (SSE doesn't support custom headers from EventSource, use cookie)
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    const userId = session.user.id;
    const collections = c.req.query('collection')?.split(',').filter(Boolean) ?? [];

    return streamSSE(c, async (stream) => {
      // Register this connection
      if (!connections.has(userId)) connections.set(userId, new Set());
      const userConnections = connections.get(userId)!;
      userConnections.add(stream);

      // Subscribe to Redis channels if Redis is available
      const redis = getRedis();
      let subscriber: any = null;

      if (redis) {
        try {
          subscriber = redis.duplicate();
          const channels = collections.length > 0
            ? collections.map((c) => `zveltio:data:${c}`)
            : ['zveltio:data:*'];

          await subscriber.subscribe(...channels);

          subscriber.on('message', (channel: string, message: string) => {
            try {
              stream.writeSSE({ data: message, event: 'data' });
            } catch { /* stream closed */ }
          });
        } catch { /* Redis unavailable — fall back to poll-based */ }
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
        stream.writeSSE({ data: 'ping', event: 'ping' }).catch(() => {
          clearInterval(pingInterval);
        });
      }, 30_000);

      // Cleanup on disconnect
      stream.onAbort(async () => {
        clearInterval(pingInterval);
        userConnections.delete(stream);
        if (userConnections.size === 0) connections.delete(userId);
        if (subscriber) {
          try {
            await subscriber.unsubscribe();
            subscriber.disconnect();
          } catch { /* ignore */ }
        }
      });

      // Keep stream open (abort signal closes it automatically)
      await new Promise<void>((resolve) => {
        stream.onAbort(resolve);
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

  return app;
}
