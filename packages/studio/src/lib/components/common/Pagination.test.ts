/**
 * Component test for Pagination — the range readout, prev/next disabling at
 * the edges, and the onchange callback firing with the target page.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import Pagination from './Pagination.svelte';

describe('Pagination', () => {
  it('renders nothing when everything fits on one page', () => {
    const { container } = render(Pagination, {
      props: { total: 5, page: 1, limit: 10, onchange: vi.fn() },
    });
    expect(container.querySelector('button')).toBeNull();
    cleanup();
  });

  it('shows the current from–to of total range', () => {
    render(Pagination, { props: { total: 95, page: 2, limit: 20, onchange: vi.fn() } });
    // page 2 of 20/page → items 21–40
    expect(screen.getByText('21–40 of 95')).toBeInTheDocument();
    cleanup();
  });

  it('disables « on the first page and » on the last', () => {
    const first = render(Pagination, { props: { total: 50, page: 1, limit: 10, onchange: vi.fn() } });
    expect(screen.getByRole('button', { name: '«' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '»' })).not.toBeDisabled();
    cleanup();

    render(Pagination, { props: { total: 50, page: 5, limit: 10, onchange: vi.fn() } });
    expect(screen.getByRole('button', { name: '»' })).toBeDisabled();
    cleanup();
  });

  it('fires onchange with the next page number', async () => {
    const onchange = vi.fn();
    render(Pagination, { props: { total: 50, page: 2, limit: 10, onchange } });
    screen.getByRole('button', { name: '»' }).click();
    expect(onchange).toHaveBeenCalledWith(3);
    screen.getByRole('button', { name: '«' }).click();
    expect(onchange).toHaveBeenCalledWith(1);
    cleanup();
  });
});
