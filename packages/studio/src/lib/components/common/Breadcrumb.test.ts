/**
 * Component test for Breadcrumb — intermediate crumbs with an href render as
 * links; the last crumb always renders as plain text (never a link) even when
 * it carries an href.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import Breadcrumb from './Breadcrumb.svelte';

describe('Breadcrumb', () => {
  it('links intermediate crumbs and leaves the last as text', () => {
    render(Breadcrumb, {
      props: {
        crumbs: [
          { label: 'Home', href: '/' },
          { label: 'Users', href: '/users' },
          { label: 'Ada', href: '/users/1' },
        ],
      },
    });
    // First two are links…
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Users' })).toHaveAttribute('href', '/users');
    // …the last is not a link even though it has an href.
    expect(screen.queryByRole('link', { name: 'Ada' })).toBeNull();
    expect(screen.getByText('Ada')).toBeInTheDocument();
    cleanup();
  });

  it('renders a crumb without href as plain text', () => {
    render(Breadcrumb, { props: { crumbs: [{ label: 'Standalone' }] } });
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Standalone')).toBeInTheDocument();
    cleanup();
  });
});
