import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The drawer stays in the DOM when closed — it animates rather than unmounting.
 * `aria-hidden` alone hides it from a screen reader while leaving every input
 * in the tab order, which is the one combination the ARIA spec forbids: a
 * keyboard user tabs into a form nobody can see.
 */
import AddFieldDrawer from './AddFieldDrawer.svelte';

const props = (open: boolean) => ({
  open,
  fieldTypes: [{ type: 'text', label: 'Text', category: 'text' }],
  allCollections: [],
  collectionName: 'orders',
  onsave: vi.fn(),
});

afterEach(cleanup);

describe('AddFieldDrawer', () => {
  it('takes its controls out of the tab order while it is closed', () => {
    const { container } = render(AddFieldDrawer, { props: props(false) });
    const root = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(root.getAttribute('aria-hidden')).toBe('true');
    expect(root.hasAttribute('inert')).toBe(true);
  });

  it('is reachable again once open', () => {
    const { container } = render(AddFieldDrawer, { props: props(true) });
    const root = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(root.hasAttribute('inert')).toBe(false);
  });
});

/**
 * Open, it says `aria-modal="true"`, so the keyboard has to treat it as one: it
 * had no Escape at all, left focus on the button behind the backdrop that opened
 * it, and carried no accessible name.
 */
describe('AddFieldDrawer as a modal dialog', () => {
  // Focusable filters drop elements with a null offsetParent, which jsdom
  // reports for everything — see Modal.test.ts.
  const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
  beforeEach(() =>
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get(this: HTMLElement) {
        return this.parentElement;
      },
    }),
  );
  afterEach(() => {
    if (desc) Object.defineProperty(HTMLElement.prototype, 'offsetParent', desc);
  });

  it('is named by its heading', () => {
    const { getByRole } = render(AddFieldDrawer, { props: props(true) });
    expect(getByRole('dialog')).toHaveAccessibleName(/add field/i);
  });

  it('moves focus into the drawer when open', async () => {
    const { getByRole } = render(AddFieldDrawer, { props: props(true) });
    const dialog = getByRole('dialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  it('closes on Escape', async () => {
    const { getByRole } = render(AddFieldDrawer, { props: props(true) });
    const dialog = getByRole('dialog');
    await fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(dialog).toHaveAttribute('aria-hidden', 'true'));
  });

  it('does not take Escape or focus while closed', async () => {
    const before = document.activeElement;
    render(AddFieldDrawer, { props: props(false) });
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.activeElement).toBe(before);
  });
});
