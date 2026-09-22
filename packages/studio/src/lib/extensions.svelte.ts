import { api } from './api.js';
import type { ExtensionMeta } from './nav-model.js';

export type { ExtensionMeta } from './nav-model.js';

let activeExtensions = $state<string[]>([]);
let extensionMetaList = $state<ExtensionMeta[]>([]);
let initialized = $state(false);
let loadFailed = $state(false);

/**
 * `api.fetch` returns the Response, status and all — reading `.json()` off it
 * without checking `res.ok` treated every failure as an answer. A 401 on an
 * expired session, a 403 or a 500 parses as a problem+json body with no
 * `extensions` key, so `data.extensions || []` emptied the list and the shell
 * rendered an instance with nothing installed. Throwing keeps the last known
 * list in place and lets the caller record the failure.
 */
async function fetchExtensions(): Promise<void> {
  const res = await api.fetch(`/api/extensions`);
  if (!res.ok) throw new Error(`GET /api/extensions answered ${res.status}`);
  const data = await res.json();
  activeExtensions = data.extensions || [];
  extensionMetaList = data.meta || [];
}

export async function initExtensions(): Promise<void> {
  try {
    await fetchExtensions();
    loadFailed = false;
  } catch (err) {
    console.error('Failed to load extensions:', err);
    loadFailed = true;
  } finally {
    // Always: the shell waits on `initialized` before it renders, and a failed
    // load that never sets it leaves a permanent spinner.
    initialized = true;
  }
}

export async function refreshExtensions(): Promise<void> {
  try {
    await fetchExtensions();
    loadFailed = false;
  } catch (err) {
    console.error('Failed to refresh extensions:', err);
    loadFailed = true;
  }
}

export const extensions = {
  get active() {
    return activeExtensions;
  },
  get initialized() {
    return initialized;
  },
  /** True when the last load or refresh failed — the list below may be stale. */
  get loadFailed() {
    return loadFailed;
  },
  get meta() {
    return extensionMetaList;
  },
  isActive: (name: string) => activeExtensions.includes(name),
  hasCategory: (category: string) => activeExtensions.some((e) => e.startsWith(category)),
};
