/**
 * Component test for EmptyState — default microcopy, and the two non-snippet
 * action modes: an anchor when actionHref is set, a button (firing onaction)
 * otherwise.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import EmptyState from './EmptyState.svelte';

describe('EmptyState', () => {
  it('renders the provided title + description', () => {
    render(EmptyState, { props: { title: 'No contacts yet', description: 'Add your first one.' } });
    expect(screen.getByText('No contacts yet')).toBeInTheDocument();
    expect(screen.getByText('Add your first one.')).toBeInTheDocument();
    cleanup();
  });

  it('renders the action as a link when actionHref is set', () => {
    render(EmptyState, {
      props: { title: 't', actionLabel: 'Create', actionHref: '/new' },
    });
    const link = screen.getByRole('link', { name: 'Create' });
    expect(link).toHaveAttribute('href', '/new');
    cleanup();
  });

  it('renders the action as a button that fires onaction', () => {
    const onaction = vi.fn();
    render(EmptyState, { props: { title: 't', actionLabel: 'Refresh', onaction } });
    screen.getByRole('button', { name: 'Refresh' }).click();
    expect(onaction).toHaveBeenCalledOnce();
    cleanup();
  });

  it('renders no action control when only a label is given', () => {
    render(EmptyState, { props: { title: 't', actionLabel: 'Orphan' } });
    expect(screen.queryByRole('button', { name: 'Orphan' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Orphan' })).toBeNull();
    cleanup();
  });
});
