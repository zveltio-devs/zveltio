import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Everything on this screen is edited in memory until Save: the flow name, the
 * steps, their config and their order. Two ways that work was unreachable or
 * lost.
 *
 * Navigating away threw it all out silently — and the Back button sits in the
 * toolbar beside Save. The editor now asks first, through beforeNavigate.
 *
 * Reordering was drag-and-drop only, which is no reordering at all on a
 * keyboard. Alt+Arrow moves the focused step.
 */
const { navCallback, patch } = vi.hoisted(() => ({
  navCallback: { fn: null as ((nav: { cancel: () => void }) => void) | null },
  patch: vi.fn(async (_path: string, _body: { steps: { id: string; order: number }[] }) => ({})),
}));

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
  beforeNavigate: (fn: (nav: { cancel: () => void }) => void) => {
    navCallback.fn = fn;
  },
}));
vi.mock('$app/state', () => ({ page: { params: { id: 'f1' } } }));
vi.mock('$app/paths', () => ({ base: '' }));
vi.mock('$lib/api.js', () => ({
  api: {
    get: vi.fn(async () => ({
      flow: {
        id: 'f1',
        name: 'Nightly sync',
        description: null,
        trigger_type: 'cron',
        trigger_config: { expression: '0 3 * * *' },
        is_active: true,
        steps: [
          { id: 's1', name: 'First', type: 'http_request', config: {}, order: 0 },
          { id: 's2', name: 'Second', type: 'send_email', config: {}, order: 1 },
        ],
      },
    })),
    patch,
  },
}));
vi.mock('$lib/stores/toast.svelte.js', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import Page from './+page.svelte';

const stepNames = (container: HTMLElement) =>
  [...container.querySelectorAll('[draggable="true"] p.font-medium')].map((p) =>
    p.textContent?.trim(),
  );

beforeEach(() => {
  navCallback.fn = null;
  patch.mockClear();
});
afterEach(cleanup);

describe('flow editor', () => {
  it('lets a navigation through untouched', async () => {
    render(Page);
    await waitFor(() => expect(document.body.textContent).toContain('First'));

    const cancel = vi.fn();
    navCallback.fn?.({ cancel });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('cancels the navigation when there are unsaved changes and the user declines', async () => {
    const { container } = render(Page);
    await waitFor(() => expect(document.body.textContent).toContain('First'));

    const firstStep = container.querySelector('[draggable="true"]') as HTMLElement;
    firstStep.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }),
    );

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const cancel = vi.fn();
    navCallback.fn?.({ cancel });
    expect(cancel).toHaveBeenCalledOnce();
    confirmSpy.mockRestore();
  });

  it('stops asking once the work is saved', async () => {
    const { container } = render(Page);
    await waitFor(() => expect(document.body.textContent).toContain('First'));

    (container.querySelector('[draggable="true"]') as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }),
    );
    const save = [...container.querySelectorAll('button')].find((b) =>
      b.className.includes('btn-primary'),
    ) as HTMLButtonElement;
    save.click();
    await waitFor(() => expect(patch).toHaveBeenCalled());

    const cancel = vi.fn();
    navCallback.fn?.({ cancel });
    expect(cancel).not.toHaveBeenCalled();
  });

  /**
   * Save sends a snapshot and then marked the whole editor clean. A change
   * made while the request was in flight never reached the engine, and the
   * guard no longer asked before throwing it away.
   */
  it('keeps asking when the work changed while Save was in flight', async () => {
    const { container } = render(Page);
    await waitFor(() => expect(document.body.textContent).toContain('First'));

    let release!: () => void;
    patch.mockImplementationOnce(() => new Promise((r) => (release = () => r({}))));
    const move = () =>
      (container.querySelector('[draggable="true"]') as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }),
      );
    move();
    const save = [...container.querySelectorAll('button')].find((b) =>
      b.className.includes('btn-primary'),
    ) as HTMLButtonElement;
    save.click();
    await waitFor(() => expect(patch).toHaveBeenCalled());
    move(); // after the snapshot left
    release();
    await waitFor(() => expect(save.disabled).toBe(false));

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const cancel = vi.fn();
    navCallback.fn?.({ cancel });
    expect(cancel).toHaveBeenCalledOnce();
    confirmSpy.mockRestore();
  });

  it('reorders steps from the keyboard, and saves the new order', async () => {
    const { container } = render(Page);
    await waitFor(() => expect(document.body.textContent).toContain('First'));
    expect(stepNames(container)).toEqual(['First', 'Second']);

    (container.querySelector('[draggable="true"]') as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }),
    );
    await waitFor(() => expect(stepNames(container)).toEqual(['Second', 'First']));

    const save = [...container.querySelectorAll('button')].find((b) =>
      b.className.includes('btn-primary'),
    ) as HTMLButtonElement;
    save.click();
    await waitFor(() => expect(patch).toHaveBeenCalled());
    const body = patch.mock.calls[0]![1];
    expect(body.steps.map((s) => [s.id, s.order])).toEqual([
      ['s2', 0],
      ['s1', 1],
    ]);
  });

  it('does not move the first step above the top', async () => {
    const { container } = render(Page);
    await waitFor(() => expect(document.body.textContent).toContain('First'));

    (container.querySelector('[draggable="true"]') as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }),
    );
    expect(stepNames(container)).toEqual(['First', 'Second']);
  });
});
