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
import { describe, expect, it, vi } from 'vitest';
import Modal from './Modal.svelte';
import ModalHarness from './ModalHarness.test.svelte';

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

    // Tab from the last focusable must wrap to the first, not escape the dialog.
    const focusable = screen.getByTestId('last-field') as HTMLElement;
    focusable.focus();
    await fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).not.toBe(document.body);
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
