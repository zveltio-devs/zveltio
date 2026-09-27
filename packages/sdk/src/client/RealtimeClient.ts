import { WS_UNAUTHORIZED } from '../realtime.js';
import type { RealtimeMessage } from '../types/index.js';

type EventCallback = (message: RealtimeMessage) => void;
type StatusCallback = (status: 'connecting' | 'connected' | 'disconnected') => void;

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private baseUrl: string;
  private headers: Record<string, string> | undefined;
  private subscriptions = new Map<string, Set<EventCallback>>();
  private statusCallbacks = new Set<StatusCallback>();
  private unauthorizedCallbacks = new Set<() => void>();
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  /** Set by a 4001 close; only an explicit `connect()` clears it. */
  private unauthorized = false;

  /**
   * @param options.headers Sent with the upgrade — e.g. `{ 'X-API-Key': key }`
   *   for a server-side client (Bun, Node). A browser cannot set headers on a
   *   WebSocket and authenticates by session cookie.
   */
  constructor(baseUrl: string, options: { headers?: Record<string, string> } = {}) {
    this.baseUrl = baseUrl;
    this.headers = options.headers;
  }

  /** Open the socket — also after a 4001, once the app has re-authenticated. */
  connect(): void {
    this.unauthorized = false;
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;
    this.reconnectDelay = 1000;
    this.open();
  }

  private open(): void {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return;
    }

    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/api/ws';
    // The two-argument form with `{ headers }` is the Bun/undici extension.
    const ws = this.headers
      ? new WebSocket(wsUrl, { headers: this.headers } as unknown as string[])
      : new WebSocket(wsUrl);
    this.ws = ws;
    this.notifyStatus('connecting');

    ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.reconnectAttempts = 0;
      this.notifyStatus('connected');
      // Re-subscribe all active subscriptions
      for (const channel of this.subscriptions.keys()) {
        this.sendSubscribe(channel);
      }
    };

    ws.onmessage = (event) => {
      try {
        const message: RealtimeMessage = JSON.parse(event.data);
        const key = `${message.collection}:${message.event}`;
        const wildcard = `${message.collection}:*`;
        const allWildcard = `*:*`;

        for (const [sub, callbacks] of this.subscriptions) {
          if (sub === key || sub === wildcard || sub === allWildcard) {
            callbacks.forEach((cb) => cb(message));
          }
        }
      } catch {
        /* ignore invalid messages */
      }
    };

    ws.onclose = (event) => {
      // A socket `disconnect()` dropped still reports; one already replaced does not.
      if (this.ws !== ws) {
        if (this.ws === null) this.notifyStatus('disconnected');
        return;
      }
      this.notifyStatus('disconnected');
      if (event?.code === WS_UNAUTHORIZED) {
        // Credentials revoked: every retry would be refused with 401.
        this.unauthorized = true;
        this.unauthorizedCallbacks.forEach((cb) => cb());
        return;
      }
      // Bounded: a refused handshake (401) is not visible to a WebSocket in any
      // runtime — it closes as 1002/1006 — so it must not be retried forever.
      if (!this.shouldReconnect || this.reconnectAttempts >= this.maxReconnectAttempts) return;
      this.reconnectAttempts++;
      this.reconnectTimer = setTimeout(() => this.open(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  // Subscribe to events on a collection
  // pattern examples: 'products:insert', 'products:*', '*:*'
  subscribe(collection: string, event: string | '*', callback: EventCallback): () => void {
    const key = `${collection}:${event}`;

    if (!this.subscriptions.has(key)) {
      this.subscriptions.set(key, new Set());
    }
    this.subscriptions.get(key)!.add(callback);

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscribe(key);
    } else if (!this.unauthorized) {
      this.connect();
    }
    // After a 4001 the subscription is only recorded: the next explicit
    // `connect()` sends it. Dialling again would only be refused.

    // Return unsubscribe function
    return () => {
      this.subscriptions.get(key)?.delete(callback);
      if (this.subscriptions.get(key)?.size === 0) {
        this.subscriptions.delete(key);
        this.sendUnsubscribe(key);
      }
    };
  }

  onStatusChange(callback: StatusCallback): () => void {
    this.statusCallbacks.add(callback);
    return () => this.statusCallbacks.delete(callback);
  }

  /** Called when the engine ends the socket because its credentials were revoked. */
  onUnauthorized(callback: () => void): () => void {
    this.unauthorizedCallbacks.add(callback);
    return () => this.unauthorizedCallbacks.delete(callback);
  }

  private sendSubscribe(channel: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe', channel }));
    }
  }

  private sendUnsubscribe(channel: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'unsubscribe', channel }));
    }
  }

  private notifyStatus(status: 'connecting' | 'connected' | 'disconnected'): void {
    this.statusCallbacks.forEach((cb) => cb(status));
  }
}
