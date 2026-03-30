import { browser } from '$app/environment';
import { initZveltio } from '$lib/zveltio';

export const ssr = false;
export const prerender = false;

const ENGINE_URL: string =
  import.meta.env.PUBLIC_ENGINE_URL ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');

export async function load({ fetch }) {
  if (browser) {
    initZveltio().catch(() => {});
  }

  // Load zone theme + nav — uses the 'client' zone from the Zones API
  try {
    const res = await fetch(`${ENGINE_URL}/api/zones/client/render`);
    if (res.ok) {
      const data = await res.json();
      return { theme: data.zone ?? null, nav: data.pages ?? [] };
    }
  } catch { /* engine not ready — degrade gracefully */ }

  return { theme: null, nav: [] };
}
