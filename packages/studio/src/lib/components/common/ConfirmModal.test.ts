/**
 * Component test for ConfirmModal — hidden until `open`, wires the confirm and
 * cancel callbacks, and treats Escape on the backdrop as cancel (never
 * confirm).
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import ConfirmModal from './ConfirmModal.svelte';

const base = {
  title: 'Delete item',
  message: 'This cannot be undone.',
  onconfirm: vi.fn(),
  oncancel: vi.fn(),
};

describe('ConfirmModal', () => {
  it('renders nothing while closed', () => {
    render(ConfirmModal, { props: { ...base, open: false } });
    expect(screen.queryByText('Delete item')).toBeNull();
    cleanup();
  });

  it('shows title + message when open', () => {
    render(ConfirmModal, { props: { ...base, open: true } });
    expect(screen.getByText('Delete item')).toBeInTheDocument();
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
    cleanup();
  });

  it('fires onconfirm from the confirm button and oncancel from cancel', () => {
    const onconfirm = vi.fn();
    const oncancel = vi.fn();
    render(ConfirmModal, {
      props: { ...base, open: true, confirmLabel: 'Delete', onconfirm, oncancel },
    });
    screen.getByRole('button', { name: 'Delete' }).click();
    expect(onconfirm).toHaveBeenCalledOnce();
    expect(oncancel).not.toHaveBeenCalled();
    cleanup();
  });

  /**
   * This asserted Escape on the BACKDROP, which is where the handler used to
   * live — on a `role="button" tabindex="0"` div. Nothing ever moved focus
   * there, so in a real browser Escape did nothing at all; the test passed
   * because it dispatched the event straight at the element.
   *
   * Escape belongs to the dialog. The backdrop is now `aria-hidden` and out of
   * the tab order, because a focusable backdrop only gave a keyboard user
   * somewhere useless to land.
   */
  it('cancels on Escape anywhere in the dialog', async () => {
    const onconfirm = vi.fn();
    const oncancel = vi.fn();
    render(ConfirmModal, { props: { ...base, open: true, onconfirm, oncancel } });
    const dialog = screen.getByRole('dialog');
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(oncancel).toHaveBeenCalledOnce();
    expect(onconfirm).not.toHaveBeenCalled();
    cleanup();
  });

  /**
   * Used in 36 places, most of them destructive. To a screen reader it was not a
   * dialog at all: no role, no name, no description — the content simply
   * appeared somewhere in the page with no announcement.
   */
  it('is a dialog, and is named and described by its own title and message', () => {
    render(ConfirmModal, { props: { ...base, open: true } });
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // Resolved through the ids rather than asserted as strings, so this fails if
    // the association breaks even when the text is still on screen.
    const labelId = dialog.getAttribute('aria-labelledby');
    const descId = dialog.getAttribute('aria-describedby');
    expect(document.getElementById(labelId ?? '')?.textContent).toBe(base.title);
    expect(document.getElementById(descId ?? '')?.textContent).toBe(base.message);
    cleanup();
  });

  it('moves focus into the dialog when it opens', async () => {
    render(ConfirmModal, { props: { ...base, open: true, confirmLabel: 'Delete' } });
    // Focus is set in a microtask, after the element is in the document.
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement?.textContent).toBe('Delete');
    cleanup();
  });
});
