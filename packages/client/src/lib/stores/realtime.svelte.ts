/**
 * SSE realtime connection pentru notificari broadcast.
 * Separat de SyncManager (care foloseste WebSocket per colectie).
 * Acesta se conecteaza la /api/realtime (Redis Pub/Sub → SSE).
 */
export function useRealtime() {
  let isConnected = $state(false);
  const handlers = new Map<string, Set<(payload: any) => void>>();

  $effect(() => {
    if (typeof window === 'undefined') return;

    const engineUrl = import.meta.env.PUBLIC_ENGINE_URL || window.location.origin;
    const sse = new EventSource(`${engineUrl}/api/realtime`, {
      withCredentials: true,
    });

    sse.onopen = () => { isConnected = true; };
    sse.onerror = () => { isConnected = false; };

    sse.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const channelHandlers = handlers.get(data.type) || handlers.get('*');
        channelHandlers?.forEach((h) => h(data.payload ?? data));
      } catch { /* ignore parse errors */ }
    };

    return () => sse.close();
  });

  return {
    get isConnected() { return isConnected; },

    on(channel: string, handler: (payload: any) => void): () => void {
      if (!handlers.has(channel)) handlers.set(channel, new Set());
      handlers.get(channel)!.add(handler);
      return () => handlers.get(channel)?.delete(handler);
    },
  };
}
