import type { RealtimeMessage } from '../types/index.js';

type EventCallback = (message: RealtimeMessage) => void;
type StatusCallback = (status: 'connecting' | 'connected' | 'disconnected') => void;

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private baseUrl: string;
  private subscriptions = new Map<string, Set<EventCallback>>();
  private statusCallbacks = new Set<StatusCallback>();
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private shouldReconnect = true;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/api/ws';
    this.ws = new WebSocket(wsUrl);
    this.notifyStatus('connecting');

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.notifyStatus('connected');
      // Re-subscribe all active subscriptions
      for (const channel of this.subscriptions.keys()) {
        this.sendSubscribe(channel);
      }
    };

    this.ws.onmessage = (event) => {
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
      } catch { /* ignore invalid messages */ }
    };

    this.ws.onclose = () => {
      this.notifyStatus('disconnected');
      if (this.shouldReconnect) {
        setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      }
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  disconnect(): void {
    this.shouldReconnect = false;
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
    } else {
      this.connect();
    }

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
