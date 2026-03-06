import { browser } from '$app/environment';
import { initZveltio } from '$lib/zveltio';

export async function load() {
  if (browser) {
    await initZveltio();
  }
  return {};
}
