import { error } from '@sveltejs/kit';
import { m } from '#lib/i18n.svelte.js';
import type { PageLoad } from './$types';

/** One record of any collection the user may read, or `new` for an empty form. */
export const load: PageLoad = async ({ fetch, params, parent }) => {
  const { collections, collectionsFailed, engineUrl } = await parent();
  const collection = collections.find((c) => c.name === params.collection);
  if (!collection) {
    error(
      collectionsFailed ? 503 : 404,
      collectionsFailed ? m['app.collections_failed']() : m['data.collection_not_found'](),
    );
  }
  if (params.id === 'new') return { collection, record: null };

  const res = await fetch(
    `${engineUrl}/api/data/${encodeURIComponent(collection.name)}/${encodeURIComponent(params.id)}`,
    { credentials: 'include' },
  );
  if (!res.ok)
    error(
      res.status,
      ((await res.json().catch(() => null))?.error as string) ?? m['data.load_failed'](),
    );
  return { collection, record: (await res.json()) as Record<string, unknown> & { id: string } };
};
