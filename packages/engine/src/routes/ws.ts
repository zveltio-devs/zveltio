import { Hono } from 'hono';
import { auth } from '../lib/auth.js';
import { checkPermission } from '../lib/permissions.js';
import type { Database } from '../db/index.js';

interface WSConnection {
  userId: string;
  ws: any;
  subscriptions: Set<string>; // collection names or "collection:event" channels
  connectedAt: number;
}

// Connection registry: connectionId -> WSConnection
const connections = new Map<string, WSConnection>();

let wsCounter = 0;

// ── Route factory ────────────────────────────────────────────────────────────

export function wsRoutes(_db: Database, _auth: any): Hono {
  const app = new Hono();

  // GET /api/ws — Authenticate then hand off to Bun WebSocket upgrade.
  // The Hono server env must have `server` (passed via app.fetch(req, { server })).
  app.get('/api/ws', async (c) => {
    const server = (c.env as any)?.server;
    if (!server) return c.text('WebSocket not supported in this environment', 500);

    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    const id = `ws_${++wsCounter}_${Date.now()}`;
    const upgraded = server.upgrade(c.req.raw, {
      data: { id, userId: session.user.id },
    });

    if (!upgraded) return c.text('WebSocket upgrade failed', 426);
    // Bun takes over the connection — no response body needed.
    return new Response(null, { status: 101 });
  });

  // GET /api/ws/info — Connection count (unauthenticated health check)
  app.get('/api/ws/info', (c) => {
    return c.json({ connections: connections.size });
  });

  // GET /api/ws/stats — Admin: per-user connection stats
  app.get('/api/ws/stats', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    const isAdmin = await checkPermission(session.user.id, 'admin', '*');
    if (!isAdmin) return c.json({ error: 'Forbidden' }, 403);

    const activeUsers = [...new Set([...connections.values()].map((c) => c.userId))];
    return c.json({
      connections: connections.size,
      active_users: activeUsers.length,
    });
  });

  return app;
}

// ── Bun native WebSocket handlers ────────────────────────────────────────────
// Passed to Bun.serve({ websocket: websocketHandler })

export const websocketHandler = {
  open(ws: any) {
    const { id, userId } = ws.data ?? {};
    if (!id || !userId) {
      // Should never happen — the /api/ws route enforces auth before upgrade.
      ws.close(4001, 'Unauthorized');
      return;
    }

    connections.set(id, {
      userId,
      ws,
      subscriptions: new Set(['*']), // wildcard subscription by default
      connectedAt: Date.now(),
    });

    ws.send(
      JSON.stringify({
        type: 'connected',
        connectionId: id,
        userId,
        timestamp: Date.now(),
      }),
    );
  },

  message(ws: any, message: string | Buffer) {
    const conn = connections.get(ws.data?.id);
    if (!conn) return;

    try {
      const msg = JSON.parse(typeof message === 'string' ? message : message.toString());

      switch (msg.type) {
        case 'subscribe': {
          // Support both { type:'subscribe', collections:['posts','orders'] }
          // and { type:'subscribe', channel:'posts:insert' }
          if (Array.isArray(msg.collections)) {
            for (const col of msg.collections) conn.subscriptions.add(col);
            ws.send(JSON.stringify({ type: 'subscribed', collections: msg.collections }));
          } else if (typeof msg.channel === 'string') {
            conn.subscriptions.add(msg.channel);
            ws.send(JSON.stringify({ type: 'subscribed', channel: msg.channel }));
          }
          break;
        }

        case 'unsubscribe': {
          if (Array.isArray(msg.collections)) {
            for (const col of msg.collections) conn.subscriptions.delete(col);
            ws.send(JSON.stringify({ type: 'unsubscribed', collections: msg.collections }));
          } else if (typeof msg.channel === 'string') {
            conn.subscriptions.delete(msg.channel);
            ws.send(JSON.stringify({ type: 'unsubscribed', channel: msg.channel }));
          }
          break;
        }

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
          break;

        default:
          ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
      }
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
    }
  },

  close(ws: any) {
    if (ws.data?.id) {
      connections.delete(ws.data.id);
    }
  },
};

// ── Broadcast helpers ─────────────────────────────────────────────────────────
// Called by data.ts and other routes to push realtime events to subscribers.

/**
 * Broadcast a CRUD event to all WebSocket clients subscribed to the collection.
 * Subscription matching: '*', 'collection_name', or 'collection_name:event'.
 */
export function broadcastEvent(
  collection: string,
  event: 'insert' | 'update' | 'delete',
  data: any,
): void {
  const payload = JSON.stringify({ type: 'event', collection, event, data, timestamp: Date.now() });
  const specificChannel = `${collection}:${event}`;
  const wildcardChannel = `${collection}:*`;

  for (const [, conn] of connections) {
    if (
      conn.subscriptions.has('*') ||
      conn.subscriptions.has(collection) ||
      conn.subscriptions.has(wildcardChannel) ||
      conn.subscriptions.has(specificChannel)
    ) {
      try {
        conn.ws.send(payload);
      } catch {
        // Connection dead — will be cleaned up in close()
      }
    }
  }
}

/**
 * Send an event to all connections belonging to a specific user.
 */
export function broadcastToUser(userId: string, event: object): void {
  const payload = JSON.stringify(event);
  for (const [, conn] of connections) {
    if (conn.userId === userId) {
      try {
        conn.ws.send(payload);
      } catch {}
    }
  }
}

/**
 * Send an event to every connected WebSocket client.
 */
export function broadcastToAll(event: object): void {
  const payload = JSON.stringify(event);
  for (const [, conn] of connections) {
    try {
      conn.ws.send(payload);
    } catch {}
  }
}
