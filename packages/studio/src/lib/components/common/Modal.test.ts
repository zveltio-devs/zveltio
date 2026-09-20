/**
 * Component test for Modal — the accessibility behaviours a dialog owes the
 * person using it.
 *
 * This component shipped with zero importers and none of these behaviours,
 * while thirteen route files wrote their own `<dialog>`. Escape did nothing,
 * Tab walked out of the dialog into the page behind it — which is still
 * rendered, so the user ends up editing something they cannot see — and no
 * `aria-modal` told a screen reader the rest of the page was inert.
 *
 * Asserted rather than eyeballed, because every one of these is invisible to
 * someone testing with a mouse.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Modal from './Modal.svelte';
import ModalHarness from './ModalHarness.test.svelte';

/**
 * `focusables()` drops anything whose `offsetParent` is null, which is how it
 * skips hidden controls. jsdom reports null for every element, so the list was
 * always empty here and the Tab handler took its `items.length === 0` branch —
 * it called `preventDefault()` and returned without moving focus. Every
 * assertion below about the trap was therefore passing against a trap that
 * never ran.
 */
const offsetParentDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'offsetParent',
);
beforeAll(() =>
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentElement;
    },
  }),
);
afterAll(() => {
  if (offsetParentDescriptor)
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParentDescriptor);
});

describe('Modal', () => {
  it('renders nothing while closed', () => {
    render(Modal, { props: { open: false, title: 'Edit user', children: undefined as never } });
    expect(screen.queryByText('Edit user')).toBeNull();
    cleanup();
  });

  it('exposes itself as a modal dialog', () => {
    // Without aria-modal a screen reader keeps offering the page behind it.
    render(ModalHarness, { props: { open: true, title: 'Edit user' } });
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    cleanup();
  });

  it('closes on Escape from anywhere, not just the backdrop', () => {
    const onClose = vi.fn();
    render(ModalHarness, { props: { open: true, title: 'Edit user', onClose } });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('does not close on Escape when it is not dismissible', () => {
    // A destructive confirm should not be dismissable by a stray keypress.
    const onClose = vi.fn();
    render(ModalHarness, {
      props: { open: true, title: 'Confirm', onClose, dismissible: false },
    });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    cleanup();
  });

  it('hides the close button and backdrop when not dismissible', () => {
    render(ModalHarness, { props: { open: true, title: 'Confirm', dismissible: false } });
    expect(screen.queryByLabelText('Close')).toBeNull();
    cleanup();
  });

  it('keeps Tab inside the dialog', async () => {
    render(ModalHarness, { props: { open: true, title: 'Edit user' } });
    const inside = screen.getAllByRole('button').filter((b) => b.textContent?.trim() === 'Save');
    expect(inside.length).toBeGreaterThan(0);

    // Tab from the last focusable must wrap to the FIRST control in the box.
    // The previous assertion — `activeElement !== document.body` — held the
    // moment `.focus()` succeeded, so it stayed green with the trap deleted.
    // Wait out the open effect's microtask first. Without it, focusing the last
    // field and then awaiting `fireEvent` lets the effect focus the FIRST
    // control — and the assertion below reads as the trap having wrapped.
    await new Promise((r) => queueMicrotask(() => r(null)));
    const box = screen.getByRole('dialog').querySelector('.modal-box');
    const first = box?.querySelector<HTMLElement>('button, input, select, textarea, a[href]');
    const focusable = screen.getByTestId('last-field') as HTMLElement;
    focusable.focus();
    await fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    cleanup();
  });

  it('pulls focus back in when Tab is pressed from outside the box', async () => {
    // Focus reaches the page behind without the user tabbing there: a backdrop
    // click on a non-dismissible dialog, a programmatic focus, the browser
    // restoring focus after an alert. Only the Shift+Tab branch recognised
    // that, so one forward Tab walked into content the dialog covers.
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    render(ModalHarness, { props: { open: true, title: 'Edit user' } });
    // The open effect focuses into the box on a microtask. Let it land first,
    // or focusing `outside` races it and the assertion passes on the effect's
    // work rather than the trap's.
    await new Promise((r) => queueMicrotask(() => r(null)));

    outside.focus();
    expect(document.activeElement).toBe(outside);

    await fireEvent.keyDown(window, { key: 'Tab' });
    const box = screen.getByRole('dialog').querySelector('.modal-box');
    expect(box?.contains(document.activeElement)).toBe(true);

    outside.remove();
    cleanup();
  });

  it('moves focus into the dialog when it opens', async () => {
    render(ModalHarness, { props: { open: true, title: 'Edit user' } });
    await new Promise((r) => queueMicrotask(() => r(null)));
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    cleanup();
  });
});
