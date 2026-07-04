import { useEffect, useRef } from 'react';
import { ZveltioRealtime } from '@zveltio/sdk';

export function useRealtime(
  baseUrl: string,
  collection: string,
  event: string | null,
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  callback: (data: any) => void,
): void {
  const realtimeRef = useRef<ZveltioRealtime | null>(null);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!baseUrl || !collection) return;

    const realtime = new ZveltioRealtime(baseUrl);
    realtimeRef.current = realtime;
    realtime.connect();

    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const unsub = realtime.subscribe(collection, (data: any) => {
      if (!event || data.event === event) {
        callbackRef.current(data);
      }
    });

    return () => {
      unsub();
      realtime.disconnect();
      realtimeRef.current = null;
    };
  }, [baseUrl, collection, event]);
}
