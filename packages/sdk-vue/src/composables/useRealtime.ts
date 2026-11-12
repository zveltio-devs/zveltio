import { onMounted, onUnmounted } from 'vue';
import { type RealtimeRecordEvent, ZveltioRealtime } from '@zveltio/sdk';

export function useRealtime(
  baseUrl: string,
  collection: string,
  event: string | null,
  /** `event.id` is always set; `event.data` only when the engine sends it. */
  callback: (event: RealtimeRecordEvent) => void,
): void {
  let realtime: ZveltioRealtime | null = null;
  let unsub: (() => void) | null = null;

  onMounted(() => {
    if (!baseUrl || !collection) return;
    realtime = new ZveltioRealtime(baseUrl);
    realtime.connect();
    unsub = realtime.subscribe(collection, (data) => {
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
