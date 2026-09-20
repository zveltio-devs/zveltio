import { describe, expect, it } from 'vitest';
import { hasNextPage, showPager } from './paging.js';

describe('paging without a totalPath', () => {
  // `total` is undefined for every resource whose schema omits `totalPath`.
  // The old renderer used `rows.length` as the total, so `total > limit` was
  // never true and page 2 was unreachable.
  it('offers a next page while the page comes back full', () => {
    expect(hasNextPage({ limit: 20, pageNum: 1, rowCount: 20 })).toBe(true);
    expect(showPager({ limit: 20, pageNum: 1, rowCount: 20 })).toBe(true);
  });

  it('stops on a short page', () => {
    expect(hasNextPage({ limit: 20, pageNum: 3, rowCount: 5 })).toBe(false);
  });

  it('still shows the pager on a short last page so the user can go back', () => {
    expect(showPager({ limit: 20, pageNum: 3, rowCount: 5 })).toBe(true);
  });

  it('hides the pager on a single short page', () => {
    expect(showPager({ limit: 20, pageNum: 1, rowCount: 5 })).toBe(false);
  });
});

describe('paging with a server total', () => {
  it('walks to the last page and stops there', () => {
    expect(hasNextPage({ limit: 20, pageNum: 1, rowCount: 20, total: 45 })).toBe(true);
    expect(hasNextPage({ limit: 20, pageNum: 3, rowCount: 5, total: 45 })).toBe(false);
  });

  it('hides the pager when everything fits on one page', () => {
    expect(showPager({ limit: 20, pageNum: 1, rowCount: 7, total: 7 })).toBe(false);
  });

  it('treats a missing or nonsense limit as unpaged', () => {
    expect(hasNextPage({ limit: 0, pageNum: 1, rowCount: 20, total: 45 })).toBe(false);
  });
});
