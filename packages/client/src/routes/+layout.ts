import { browser } from '$app/environment';
import { initZveltio } from '$lib/zveltio';

export const ssr = false;
export const prerender = false;

export async function load() {
  if (browser) {
    await initZveltio();
  }
  return {};
}
