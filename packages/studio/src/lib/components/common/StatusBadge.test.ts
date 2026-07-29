/**
 * Component test for StatusBadge — status → daisyUI colour mapping, label
 * fallback, and case-insensitive matching with a safe default.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import StatusBadge from './StatusBadge.svelte';

describe('StatusBadge', () => {
  it('maps a known status to its colour class', () => {
    render(StatusBadge, { props: { status: 'active' } });
    const badge = screen.getByText('active');
    expect(badge).toHaveClass('badge-success');
    cleanup();
  });

  it('matches status case-insensitively', () => {
    render(StatusBadge, { props: { status: 'PENDING' } });
    expect(screen.getByText('PENDING')).toHaveClass('badge-warning');
    cleanup();
  });

  it('falls back to badge-neutral for an unknown status', () => {
    render(StatusBadge, { props: { status: 'whatever' } });
    expect(screen.getByText('whatever')).toHaveClass('badge-neutral');
    cleanup();
  });

  it('prefers an explicit label over the raw status', () => {
    render(StatusBadge, { props: { status: 'active', label: 'Live' } });
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.queryByText('active')).toBeNull();
    cleanup();
  });
});
