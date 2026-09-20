/**
 * The admin shell must come back the way it was left.
 *
 * These three preferences were read in the layout's `onMount` while three
 * `$effect` blocks declared above it wrote the same keys. `onMount` is itself a
 * user effect, so it ran second: every reload wrote `false` / `light` /
 * `comfortable` over the stored values before anything read them, and a chosen
 * theme, a collapsed sidebar and compact density never survived a refresh.
 *
 * Reading at module initialisation is what makes that unreproducible, so this
 * asserts the values as the module hands them over. `vi.resetModules()` is the
 * point of the test rather than hygiene: the read happens exactly once, when
 * the module is first evaluated.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

async function loadChrome() {
  vi.resetModules();
  return (await import('./chrome.svelte.js')).chrome;
}

describe('chrome preferences', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('comes back dark when dark was stored', async () => {
    localStorage.setItem('zveltio-theme', 'dark');
    expect((await loadChrome()).dark).toBe(true);
  });

  it('comes back collapsed and compact when those were stored', async () => {
    localStorage.setItem('zveltio-sidebar', 'true');
    localStorage.setItem('zveltio-density', 'compact');
    const chrome = await loadChrome();
    expect(chrome.collapsed).toBe(true);
    expect(chrome.density).toBe('compact');
  });

  it('falls back to the defaults when nothing is stored', async () => {
    const chrome = await loadChrome();
    expect(chrome).toEqual({ collapsed: false, dark: false, density: 'comfortable' });
  });

  it('survives localStorage throwing, as it does in private mode', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const chrome = await loadChrome();
    expect(chrome.density).toBe('comfortable');
    vi.restoreAllMocks();
  });
});
