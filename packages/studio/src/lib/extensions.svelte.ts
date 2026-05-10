import { ENGINE_URL } from './config.js';

export type ExtensionMeta = {
  name: string;
  displayName?: string;
  description?: string;
  contributes?: { engine?: boolean; studio?: boolean; client?: boolean };
  studio?: { pages?: Array<{ path: string; label: string; icon?: string }> };
};

let activeExtensions = $state<string[]>([]);
let extensionBundles = $state<Array<{ name: string; url: string }>>([]);
let extensionMetaList = $state<ExtensionMeta[]>([]);
let initialized = $state(false);

export async function initExtensions(): Promise<void> {
  try {
    const res = await fetch(`${ENGINE_URL}/api/extensions`, { credentials: 'include' });
    const data = await res.json();
    activeExtensions = data.extensions || [];
    extensionBundles = data.bundles || [];
    extensionMetaList = data.meta || [];

    await loadExtensionBundles(extensionBundles);
    initialized = true;
  } catch (err) {
    console.error('Failed to load extensions:', err);
    initialized = true;
  }
}

// Load extension bundles as ES modules via dynamic import().
// Svelte runtime is shared through the import map in app.html —
// no window.__SvelteRuntime globals, no duplicate Svelte instances.
async function loadExtensionBundles(
  bundles: Array<{ name: string; url: string }>,
): Promise<void> {
  await Promise.allSettled(bundles.map((bundle) => loadBundle(bundle)));
}

async function loadBundle(bundle: { name: string; url: string }): Promise<void> {
  const url = `${ENGINE_URL}${bundle.url}`;
  try {
    // Dynamic ESM import — browser module cache ensures idempotency.
    await import(/* @vite-ignore */ url);
    console.log(`🔌 Extension UI loaded: ${bundle.name}`);
  } catch (err) {
    console.error(`❌ Extension UI failed to load: ${bundle.name}`, err);
  }
}

export async function refreshExtensions(): Promise<void> {
  try {
    const res = await fetch(`${ENGINE_URL}/api/extensions`, { credentials: 'include' });
    const data = await res.json();
    const newBundles: Array<{ name: string; url: string }> = data.bundles || [];
    await loadExtensionBundles(newBundles);
    activeExtensions = data.extensions || [];
    extensionBundles = newBundles;
    extensionMetaList = data.meta || [];
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
