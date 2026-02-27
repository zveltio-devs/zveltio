import { Hono } from 'hono';
import type { Database } from '../db/index.js';

// Connection registry: socketId -> { ws, subscriptions: Set<string> }
const connections = new Map<string, { ws: any; subscriptions: Set<string> }>();

let wsCounter = 0;

export function wsRoutes(_db: Database, _auth: any) {
  const app = new Hono();

  // WebSocket upgrade endpoint
  // The actual upgrade is handled in engine index.ts via Bun.serve websocket option
  // This route exposes a health check and connection count
  app.get('/api/ws/info', (c) => {
    return c.json({ connections: connections.size });
  });

  return app;
}

// WebSocket handlers for Bun.serve({ websocket: ... })
export const websocketHandler = {
  open(ws: any) {
    const id = `ws_${++wsCounter}_${Date.now()}`;
    ws.data = { id };
    connections.set(id, { ws, subscriptions: new Set() });
  },

  message(ws: any, message: string | Buffer) {
    const conn = connections.get(ws.data?.id);
    if (!conn) return;

    try {
      const msg = JSON.parse(typeof message === 'string' ? message : message.toString());

      switch (msg.type) {
        case 'subscribe': {
          // msg.channel: "collection:event" e.g. "posts:insert" or "posts:*"
          const channel: string = msg.channel;
          if (channel) {
            conn.subscriptions.add(channel);
            ws.send(JSON.stringify({ type: 'subscribed', channel }));
          }
          break;
        }

        case 'unsubscribe': {
          const channel: string = msg.channel;
          conn.subscriptions.delete(channel);
          ws.send(JSON.stringify({ type: 'unsubscribed', channel }));
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

/**
 * Broadcast a realtime event to all subscribers of a channel.
 * Called by data.ts on insert/update/delete.
 */
export function broadcastEvent(collection: string, event: 'insert' | 'update' | 'delete', data: any) {
  const wildcardChannel = `${collection}:*`;
  const specificChannel = `${collection}:${event}`;

  for (const [, conn] of connections) {
    if (conn.subscriptions.has(wildcardChannel) || conn.subscriptions.has(specificChannel)) {
      try {
        conn.ws.send(JSON.stringify({ type: 'event', collection, event, data }));
      } catch {
        // ignore closed connections — they'll be cleaned up in close()
      }
    }
  }
}
