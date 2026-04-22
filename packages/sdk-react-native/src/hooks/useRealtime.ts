import { useEffect, useRef } from 'react';
import { useZveltioClient } from '../context.js';

// React Native doesn't have EventSource — connect to /api/ws via WebSocket.
// All globals (WebSocket, setTimeout, clearTimeout) exist in the RN runtime;
// we access them via globalThis to avoid TypeScript lib conflicts.
const g = globalThis as any;

export function useRealtime(
  collection: string,
  event: string | null,
  callback: (data: any) => void,
): void {
  const client = useZveltioClient();
  const wsRef = useRef<any>(null);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!collection) return;

    const baseUrl: string = (client as any).baseUrl ?? (client as any).url ?? '';
    const wsUrl = baseUrl.replace(/^http/, 'ws') + '/api/ws';

    let ws: any;
    let reconnectTimer: any;
    let destroyed = false;

    function connect() {
      ws = new g.WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'subscribe', collection }));
      };

      ws.onmessage = (msg: any) => {
        try {
          const payload = JSON.parse(msg.data);
          if (payload.collection !== collection) return;
          if (event && payload.event !== event) return;
          callbackRef.current(payload);
        } catch { /* ignore malformed */ }
      };

      ws.onclose = () => {
        if (!destroyed) reconnectTimer = g.setTimeout(connect, 3000);
      };

      ws.onerror = () => { ws.close(); };
    }

    connect();

    return () => {
      destroyed = true;
      g.clearTimeout(reconnectTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [collection, event, (client as any).baseUrl]);
}
