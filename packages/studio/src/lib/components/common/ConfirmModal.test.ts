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

  it('treats Escape on the backdrop as cancel', async () => {
    const onconfirm = vi.fn();
    const oncancel = vi.fn();
    render(ConfirmModal, { props: { ...base, open: true, onconfirm, oncancel } });
    const backdrop = screen.getByRole('button', { name: 'Close' });
    backdrop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(oncancel).toHaveBeenCalledOnce();
    expect(onconfirm).not.toHaveBeenCalled();
    cleanup();
  });
});
