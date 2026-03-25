import { browser } from '$app/environment';
import { initZveltio } from '$lib/zveltio';

export const ssr = false;
export const prerender = false;

export async function load() {
  if (browser) {
    // Don't let SDK/WebSocket connection failures block the page from rendering.
    // The app works fine without realtime sync (degraded mode).
    initZveltio().catch(() => {});
  }
  return {};
}
