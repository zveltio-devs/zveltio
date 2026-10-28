import { error } from '@sveltejs/kit';
import { m } from '#lib/i18n.svelte.js';
import { isSortable } from '#lib/workspace/fields.js';
import type { PageLoad } from './$types';

const PAGE_SIZE = 25;

/**
 * A page of any collection the user may read. The collection comes from the
 * layout's `GET /api/data` answer: one it does not list is one this user cannot
 * read, and gets the 404 a direct request would have produced as a 403.
 */
export const load: PageLoad = async ({ fetch, params, parent, url }) => {
  const { collections, collectionsFailed, engineUrl } = await parent();
  const collection = collections.find((c) => c.name === params.collection);
  if (!collection) {
    error(
      collectionsFailed ? 503 : 404,
      collectionsFailed ? m['app.collections_failed']() : m['data.collection_not_found'](),
    );
  }

  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const search = url.searchParams.get('q') ?? '';
  // Only a column this user sees; the engine answers 400 to any other.
  const sortKey = url.searchParams.get('sort');
  const sort =
    sortKey &&
    (sortKey === 'id' || collection.fields.some((f) => f.name === sortKey && isSortable(f)))
      ? {
          key: sortKey,
          dir: url.searchParams.get('order') === 'asc' ? ('asc' as const) : ('desc' as const),
        }
      : null;
  const qs = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
  if (search) qs.set('search', search);
  if (sort) {
    qs.set('sort', sort.key);
    qs.set('order', sort.dir);
  }
  const res = await fetch(`${engineUrl}/api/data/${encodeURIComponent(collection.name)}?${qs}`, {
    credentials: 'include',
  });
  if (!res.ok)
    error(
      res.status,
      ((await res.json().catch(() => null))?.error as string) ?? m['data.load_failed'](),
    );
  const body = (await res.json()) as {
    records: Array<Record<string, unknown> & { id: string }>;
    pagination: { total?: number; page: number; limit: number; pages?: number };
  };
  return { collection, records: body.records, pagination: body.pagination, search, sort };
};
