export class ZveltioRealtime {
  private ws: WebSocket | null = null;
  private listeners: Map<string, Set<(data: any) => void>> = new Map();
  private baseUrl: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(baseUrl: string) {
    // Convert http(s) to ws(s)
    this.baseUrl = baseUrl.replace(/^http/, 'ws');
  }

  connect(): void {
    const wsUrl = `${this.baseUrl}/api/ws`;
    this.ws = new WebSocket(wsUrl);

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
            try { fn(msg); } catch { /* ignore callback errors */ }
          });
        }
      } catch { /* invalid JSON — ignore */ }
    };

    this.ws.onclose = () => {
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

  subscribe(collection: string, callback: (data: any) => void): () => void {
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

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAttempts = this.maxReconnectAttempts; // Prevent auto-reconnect
    this.ws?.close();
    this.ws = null;
    this.listeners.clear();
  }
}
