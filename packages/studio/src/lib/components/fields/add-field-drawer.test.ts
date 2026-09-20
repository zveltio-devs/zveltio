import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
