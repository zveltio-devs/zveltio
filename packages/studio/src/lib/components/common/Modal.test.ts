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
 * The dialog's behaviour comes from `bits-ui`, which finds tabbable controls
 * with `tabbable` — and that treats anything without client rects as hidden.
 * jsdom lays nothing out, so every control looked hidden, nothing was tabbable,
 * and the trap and the open-focus both did nothing. Give elements a rect.
 */
const rectsDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getClientRects');
beforeAll(() =>
  Object.defineProperty(Element.prototype, 'getClientRects', {
    configurable: true,
    value: () => [{ width: 1, height: 1 }],
  }),
);
afterAll(() => {
  if (rectsDescriptor) Object.defineProperty(Element.prototype, 'getClientRects', rectsDescriptor);
});

/** bits-ui moves focus on the frame after open; wait it out. */
const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

describe('Modal', () => {
  it('renders nothing while closed', () => {
    render(Modal, { props: { open: false, title: 'Edit user', children: undefined as never } });
    expect(screen.queryByText('Edit user')).toBeNull();
    // Nothing may cover the page either: a leftover `.modal-open` layer takes
    // every click meant for the page behind.
    expect(document.querySelector('.modal')).toBeNull();
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
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('does not close on Escape when it is not dismissible', () => {
    // A destructive confirm should not be dismissable by a stray keypress.
    const onClose = vi.fn();
    render(ModalHarness, {
      props: { open: true, title: 'Confirm', onClose, dismissible: false },
    });
    fireEvent.keyDown(document.body, { key: 'Escape' });
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
    // Wait out the open focus first, or it lands after we focus the last field
    // and the assertion reads as the trap having wrapped.
    await frame();
    const first = screen
      .getByRole('dialog')
      .querySelector<HTMLElement>('button, input, select, textarea, a[href]');
    const focusable = screen.getByTestId('last-field') as HTMLElement;
    focusable.focus();
    await fireEvent.keyDown(focusable, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    cleanup();
  });

  it('pulls focus back in when it lands outside the box', async () => {
    // Focus reaches the page behind without the user tabbing there: a backdrop
    // click on a non-dismissible dialog, a programmatic focus, the browser
    // restoring focus after an alert. The trap pulls it back the moment it
    // lands outside, not on the next Tab.
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    render(ModalHarness, { props: { open: true, title: 'Edit user' } });
    await frame();

    outside.focus();
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);

    outside.remove();
    cleanup();
  });

  it('moves focus into the dialog when it opens', async () => {
    render(ModalHarness, { props: { open: true, title: 'Edit user' } });
    await frame();
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    cleanup();
  });
});
