/**
 * Escape closes the preferences dropdown.
 *
 * `{#if open}` replaced daisyUI's focus-driven dropdown, and nothing put the
 * keyboard route back: the menu stayed open until the trigger was clicked a
 * second time.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import PreferencesMenu from './PreferencesMenu.svelte';

afterEach(cleanup);

describe('PreferencesMenu', () => {
  it('closes on Escape', async () => {
    render(PreferencesMenu, {
      props: {
        dark: false,
        density: 'comfortable',
        onToggleDark: () => {},
        onToggleDensity: () => {},
      },
    });
    const trigger = screen.getAllByRole('button')[0];
    trigger.click();
    await new Promise((r) => queueMicrotask(() => r(null)));
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await new Promise((r) => queueMicrotask(() => r(null)));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
});
