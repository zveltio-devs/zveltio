import { onMounted, onUnmounted } from 'vue';
import { ZveltioRealtime } from '@zveltio/sdk';

export function useRealtime(
  baseUrl: string,
  collection: string,
  event: string | null,
  callback: (data: any) => void,
): void {
  let realtime: ZveltioRealtime | null = null;
  let unsub: (() => void) | null = null;

  onMounted(() => {
    if (!baseUrl || !collection) return;
    realtime = new ZveltioRealtime(baseUrl);
    realtime.connect();
    unsub = realtime.subscribe(collection, (data: any) => {
      if (!event || data.event === event) {
        callback(data);
      }
    });
  });

  onUnmounted(() => {
    unsub?.();
    realtime?.disconnect();
    realtime = null;
  });
}
