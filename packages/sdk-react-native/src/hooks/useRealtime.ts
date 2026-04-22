import { useEffect, useRef } from 'react';
import { useZveltioClient } from '../context.js';

// Declare globals present in React Native runtime but absent from TypeScript's ES2020 lib
declare const WebSocket: {
  new(url: string): {
    onopen: (() => void) | null;
    onmessage: ((e: { data: string }) => void) | null;
    onclose: (() => void) | null;
    onerror: (() => void) | null;
    send(data: string): void;
    close(): void;
  };
};
declare function setTimeout(fn: () => void, ms: number): ReturnType<typeof globalThis.setTimeout>;
declare function clearTimeout(id: ReturnType<typeof globalThis.setTimeout>): void;

// React Native doesn't have EventSource — use WebSocket against /api/ws
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

    let ws: ReturnType<typeof WebSocket>;
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
        if (!destroyed) reconnectTimer = setTimeout(connect, 3000);
      };

      ws.onerror = () => { ws.close(); };
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
