export class ZveltioRealtime {
  private ws: WebSocket | null = null;
  private listeners: Map<string, Set<(data: any) => void>> = new Map();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = false;

  constructor(private baseUrl: string) {}

  connect() {
    this.shouldReconnect = true;
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/api/ws';
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      // Re-subscribe to all channels after reconnect
      for (const collection of this.listeners.keys()) {
        this.ws?.send(JSON.stringify({ action: 'subscribe', collection }));
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        const listeners = this.listeners.get(msg.collection);
        if (listeners) {
          listeners.forEach((fn) => fn(msg));
        }
      } catch {
        // ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      if (this.shouldReconnect) {
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
      }
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  subscribe(collection: string, callback: (data: any) => void): () => void {
    if (!this.listeners.has(collection)) {
      this.listeners.set(collection, new Set());
    }
    this.listeners.get(collection)!.add(callback);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action: 'subscribe', collection }));
    }
    return () => {
      this.listeners.get(collection)?.delete(callback);
      if (this.listeners.get(collection)?.size === 0) {
        this.listeners.delete(collection);
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ action: 'unsubscribe', collection }));
        }
      }
    };
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
