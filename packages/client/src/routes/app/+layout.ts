import type { LayoutLoad } from './$types';
import { requireUser } from '#lib/guards.js';

const ENGINE_URL: string =
  import.meta.env.PUBLIC_ENGINE_URL ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');

/** One collection as `GET /api/data` lists it: what the caller may read and see. */
export interface WorkspaceCollection {
  name: string;
  display_name: string | null;
  singular_name: string | null;
  icon: string | null;
  fields: Array<{
    name: string;
    type: string;
    label: string | null;
    description: string | null;
    required: boolean;
    options: Record<string, unknown> | null;
    readonly?: boolean;
  }>;
}

// The workspace is an SPA and is never indexed (ADR 0006 §3).
export const ssr = false;

/**
 * The workspace (ADR 0006): every signed-in user, and the navigation the engine
 * answers for them — `GET /api/data` lists only the collections they may read,
 * with only the fields they may see. Runs in the browser; see `#lib/guards.ts`.
 */
export const load: LayoutLoad = async ({ fetch, url, untrack }) => {
  // Untracked: the guard reads the URL only for its `returnTo`, and tracking it
  // re-ran this load — `/api/me` and `/api/data` again — on every navigation.
  const { user } = await requireUser(
    fetch,
    untrack(() => new URL(url)),
  );
  let collections: WorkspaceCollection[] = [];
  try {
    const res = await fetch(`${ENGINE_URL}/api/data`, { credentials: 'include' });
    if (res.ok)
      collections = ((await res.json()) as { collections: WorkspaceCollection[] }).collections;
  } catch {
    /* engine unreachable: the shell still renders, with no collections */
  }
  return { user, collections, engineUrl: ENGINE_URL };
};
