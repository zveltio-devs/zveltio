import { useEffect, useRef, useCallback } from 'react';
import { useZveltioClient } from '../context.js';

// React Native doesn't have EventSource — use WebSocket against /api/ws
export function useRealtime(
  collection: string,
  event: string | null,
  callback: (data: any) => void,
): void {
  const client = useZveltioClient();
  const wsRef = useRef<WebSocket | null>(null);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!collection) return;

    const baseUrl: string = (client as any).baseUrl ?? (client as any).url ?? '';
    const wsUrl = baseUrl.replace(/^http/, 'ws') + '/api/ws';

    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let destroyed = false;

    function connect() {
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'subscribe', collection }));
      };

      ws.onmessage = (msg) => {
        try {
          const payload = JSON.parse(msg.data);
          if (payload.collection !== collection) return;
          if (event && payload.event !== event) return;
          callbackRef.current(payload);
        } catch { /* ignore malformed */ }
      };

      ws.onclose = () => {
        if (!destroyed) {
          reconnectTimer = setTimeout(connect, 3000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      destroyed = true;
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [collection, event, (client as any).baseUrl]);
}
