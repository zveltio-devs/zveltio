import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { createRawSnippet } from 'svelte';

import CrudListPage from './CrudListPage.svelte';

/**
 * `count` is the unfiltered total — it drives the header badge and the search
 * threshold, and it does not move when the user types. The "no match" message
 * was keyed off `count > 0 && search !== ''`, which is true precisely when the
 * search DID match something, so the message rendered under the matching rows
 * and never rendered when the search came up empty.
 */
const text = (s: string) => createRawSnippet(() => ({ render: () => `<p>${s}</p>` }));

afterEach(cleanup);

const base = {
  title: 'Collections',
  count: 12,
  search: 'user',
  onSearchChange: () => {},
  list: text('rows'),
  noSearchMatch: createRawSnippet((q: () => string) => ({
    render: () => `<p>no match for ${q()}</p>`,
  })),
};

describe('CrudListPage', () => {
  it('stays quiet while the search still has matches on screen', () => {
    const { queryByText } = render(CrudListPage, { props: { ...base, visibleCount: 3 } });
    expect(queryByText(/no match for/)).toBeNull();
  });

  it('says so when the search matched nothing', () => {
    const { getByText } = render(CrudListPage, { props: { ...base, visibleCount: 0 } });
    expect(getByText('no match for user')).toBeTruthy();
  });

  it('falls back to the total when the caller passes no visible count', () => {
    const { queryByText } = render(CrudListPage, { props: base });
    expect(queryByText(/no match for/)).toBeNull();
  });
});
