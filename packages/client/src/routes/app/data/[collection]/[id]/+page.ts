import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/** One record of any collection the user may read, or `new` for an empty form. */
export const load: PageLoad = async ({ fetch, params, parent }) => {
  const { collections, engineUrl } = await parent();
  const collection = collections.find((c) => c.name === params.collection);
  if (!collection) error(404, 'Collection not found');
  if (params.id === 'new') return { collection, record: null };

  const res = await fetch(
    `${engineUrl}/api/data/${encodeURIComponent(collection.name)}/${encodeURIComponent(params.id)}`,
    { credentials: 'include' },
  );
  if (!res.ok)
    error(res.status, ((await res.json().catch(() => null))?.error as string) ?? 'Load failed');
  return { collection, record: (await res.json()) as Record<string, unknown> & { id: string } };
};
