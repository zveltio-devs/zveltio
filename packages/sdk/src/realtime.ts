/**
 * The engine closes a socket with this code when the session or API key it
 * opened with is no longer valid (signed out, revoked, expired, user
 * deactivated). Reconnecting is refused with 401, so clients stop instead.
 */
export const WS_UNAUTHORIZED = 4001;

/**
 * A WebSocket that sends `headers` with the upgrade where the runtime can (the
 * Bun/undici `{ headers }` second argument). A browser's constructor reads that
 * argument as subprotocols and throws on an object, so there the socket opens
 * without them and authenticates by the session cookie.
 */
export function openWebSocket(url: string, headers?: Record<string, string>): WebSocket {
  if (headers && Object.keys(headers).length > 0) {
    try {
      return new WebSocket(url, { headers } as unknown as string[]);
    } catch {
      // A browser: no header can be set on a WebSocket.
    }
  }
  return new WebSocket(url);
}

/**
 * A record event, as the engine sends it on `/api/ws`.
 *
 * `id` is always there. `data` is the record as this subscriber may read it,
 * and the engine alone decides whether to send it: a client cannot ask for it
 * and must not rely on it. Without `data`, read the record through the data
 * API — a 404 means it is gone, or not this subscriber's to see.
 */
export interface RealtimeRecordEvent<T = Record<string, unknown>> {
  type: 'event';
  collection: string;
  event: 'insert' | 'update' | 'delete';
  id: string;
  data?: T;
  timestamp: number;
}

// biome-ignore lint/suspicious/noExplicitAny: a subscriber names its own record type
type RecordListener = (event: RealtimeRecordEvent<any>) => void;

export class ZveltioRealtime {
  private ws: WebSocket | null = null;
  private listeners: Map<string, Set<RecordListener>> = new Map();
  private baseUrl: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private headers: Record<string, string> | undefined;
  private unauthorizedCallbacks = new Set<() => void>();

  /**
   * @param options.headers Sent with the upgrade — e.g. `{ 'X-API-Key': key }`
   *   for a server-side client. Bun and Node (undici) accept them; a browser
   *   cannot set headers on a WebSocket and authenticates by session cookie.
   */
  constructor(baseUrl: string, options: { headers?: Record<string, string> } = {}) {
    // Convert http(s) to ws(s)
    this.baseUrl = baseUrl.replace(/^http/, 'ws');
    this.headers = options.headers;
  }

  connect(): void {
    const wsUrl = `${this.baseUrl}/api/ws`;
    this.ws = openWebSocket(wsUrl, this.headers);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      // Re-subscribe to all existing collections using the server's expected protocol
      const collections = [...this.listeners.keys()];
      if (collections.length > 0) {
        this.ws?.send(JSON.stringify({ type: 'subscribe', collections }));
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        const collection = msg.collection;
        const subs = this.listeners.get(collection);
        if (subs) {
          subs.forEach((fn) => {
            try {
              fn(msg);
            } catch {
              /* ignore callback errors */
            }
          });
        }
      } catch {
        /* invalid JSON — ignore */
      }
    };

    this.ws.onclose = (event) => {
      if (event?.code === WS_UNAUTHORIZED) {
        // No retry: every attempt would be refused. `connect()` again once the
        // app holds a valid session or key.
        this.unauthorizedCallbacks.forEach((cb) => cb());
        return;
      }
      this.attemptReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    // Exponential backoff: 1s, 2s, 4s, 8s, ...
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  subscribe<T = Record<string, unknown>>(
    collection: string,
    callback: (event: RealtimeRecordEvent<T>) => void,
  ): () => void {
    if (!this.listeners.has(collection)) this.listeners.set(collection, new Set());
    this.listeners.get(collection)!.add(callback);

    // Send subscribe to server using correct protocol { type: 'subscribe', collections: [...] }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe', collections: [collection] }));
    }

    // Return unsubscribe function
    return () => {
      this.listeners.get(collection)?.delete(callback);
      if (this.listeners.get(collection)?.size === 0) {
        this.listeners.delete(collection);
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'unsubscribe', collections: [collection] }));
        }
      }
    };
  }

  /** Called when the engine ends the socket because its credentials were revoked. */
  onUnauthorized(callback: () => void): () => void {
    this.unauthorizedCallbacks.add(callback);
    return () => this.unauthorizedCallbacks.delete(callback);
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAttempts = this.maxReconnectAttempts; // Prevent auto-reconnect
    this.ws?.close();
    this.ws = null;
    this.listeners.clear();
  }
}
