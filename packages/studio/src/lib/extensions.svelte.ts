import { api } from './api.js';
import type { ExtensionMeta } from './nav-model.js';

export type { ExtensionMeta } from './nav-model.js';

let activeExtensions = $state<string[]>([]);
let extensionMetaList = $state<ExtensionMeta[]>([]);
let initialized = $state(false);

async function fetchExtensions(): Promise<void> {
  const res = await api.fetch(`/api/extensions`);
  const data = await res.json();
  activeExtensions = data.extensions || [];
  extensionMetaList = data.meta || [];
}

export async function initExtensions(): Promise<void> {
  try {
    await fetchExtensions();
    initialized = true;
  } catch (err) {
    console.error('Failed to load extensions:', err);
    initialized = true;
  }
}

export async function refreshExtensions(): Promise<void> {
  try {
    await fetchExtensions();
  } catch (err) {
    console.error('Failed to refresh extensions:', err);
  }
}

export const extensions = {
  get active() { return activeExtensions; },
  get initialized() { return initialized; },
  get meta() { return extensionMetaList; },
  isActive: (name: string) => activeExtensions.includes(name),
  hasCategory: (category: string) => activeExtensions.some((e) => e.startsWith(category)),
};
