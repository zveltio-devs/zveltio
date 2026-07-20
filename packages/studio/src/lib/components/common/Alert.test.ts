/**
 * Component test for the shared Alert. Proves the component harness works
 * end-to-end and locks in the a11y fix: the dismiss control is icon-only
 * (✕), so it MUST expose an accessible name for screen readers.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import Alert from './Alert.svelte';

describe('Alert', () => {
  it('renders its message', () => {
    render(Alert, { props: { type: 'info', message: 'Saved successfully' } });
    expect(screen.getByText('Saved successfully')).toBeInTheDocument();
    cleanup();
  });

  it('shows no dismiss button unless dismissible', () => {
    render(Alert, { props: { type: 'error', message: 'Oops' } });
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
  });

  it('dismiss button has an accessible name and fires onDismiss', async () => {
    const onDismiss = vi.fn();
    render(Alert, { props: { type: 'warning', message: 'Careful', dismissible: true, onDismiss } });
    const btn = screen.getByRole('button', { name: /dismiss/i });
    expect(btn).toBeInTheDocument();
    btn.click();
    expect(onDismiss).toHaveBeenCalledOnce();
    cleanup();
  });
});
