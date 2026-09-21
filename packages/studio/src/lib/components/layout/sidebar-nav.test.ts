/**
 * The nav's active-state rule, on both sidebars.
 *
 * `isActive` used a bare `startsWith`, so any path that merely began with a
 * nav href — `/admin/users-audit` against `/admin/users` — was rendered as the
 * current page. Extension page paths come from manifests in a sibling
 * repository, so nothing in this repository constrains them.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import { Database } from '@lucide/svelte';

const pathname = { value: '/admin/users-audit' };
vi.mock('$app/state', () => ({
  page: {
    get url() {
      return new URL(`http://x${pathname.value}`);
    },
  },
}));
vi.mock('$app/paths', () => ({ base: '/admin' }));

import Sidebar from './Sidebar.svelte';
import MobileSidebar from './MobileSidebar.svelte';

const nav = [{ items: [{ href: '/admin/users', icon: Database, labelKey: 'nav.users' }] }];

afterEach(cleanup);

describe('sidebar active state', () => {
  it('does not mark /admin/users current on /admin/users-audit', () => {
    pathname.value = '/admin/users-audit';
    render(Sidebar, {
      props: {
        nav,
        extNavGroups: [],
        collapsed: false,
        user: null,
        onToggleCollapse: () => {},
        onSignOut: () => {},
      },
    });
    const link = screen.getAllByRole('link').find((a) => a.getAttribute('href') === '/admin/users');
    expect(link?.getAttribute('aria-current')).toBeNull();
  });

  it('marks it current on the page itself and on a child route', () => {
    pathname.value = '/admin/users';
    render(Sidebar, {
      props: {
        nav,
        extNavGroups: [],
        collapsed: false,
        user: null,
        onToggleCollapse: () => {},
        onSignOut: () => {},
      },
    });
    let link = screen.getAllByRole('link').find((a) => a.getAttribute('href') === '/admin/users');
    expect(link?.getAttribute('aria-current')).toBe('page');
    cleanup();

    pathname.value = '/admin/users/42';
    render(Sidebar, {
      props: {
        nav,
        extNavGroups: [],
        collapsed: false,
        user: null,
        onToggleCollapse: () => {},
        onSignOut: () => {},
      },
    });
    link = screen.getAllByRole('link').find((a) => a.getAttribute('href') === '/admin/users');
    expect(link?.getAttribute('aria-current')).toBe('page');
  });

  it('applies the same rule in the mobile drawer', () => {
    pathname.value = '/admin/users-audit';
    render(MobileSidebar, { props: { open: true, nav, extNavGroups: [], onClose: () => {} } });
    const link = screen.getAllByRole('link').find((a) => a.getAttribute('href') === '/admin/users');
    expect(link?.getAttribute('aria-current')).toBeNull();
  });

  it('labels the drawer close controls as close, not as open menu', () => {
    pathname.value = '/admin/users';
    render(MobileSidebar, { props: { open: true, nav, extNavGroups: [], onClose: () => {} } });
    const labels = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(labels).not.toContain('Open menu');
    expect(labels.filter((l) => l === 'Close').length).toBe(2);
  });
});
