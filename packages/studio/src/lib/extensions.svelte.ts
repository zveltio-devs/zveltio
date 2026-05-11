import { ENGINE_URL } from './config.js';

export type ExtensionMeta = {
  name: string;
  displayName?: string;
  description?: string;
  contributes?: { engine?: boolean; studio?: boolean; client?: boolean };
  studio?: { pages?: Array<{ path: string; label: string; icon?: string }> };
};

let activeExtensions = $state<string[]>([]);
let extensionMetaList = $state<ExtensionMeta[]>([]);
let initialized = $state(false);

async function fetchExtensions(): Promise<void> {
  const res = await fetch(`${ENGINE_URL}/api/extensions`, { credentials: 'include' });
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
