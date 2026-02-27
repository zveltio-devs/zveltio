import { ENGINE_URL } from './config.js';

let activeExtensions = $state<string[]>([]);
let extensionBundles = $state<Array<{ name: string; url: string }>>([]);
let initialized = $state(false);

export async function initExtensions(): Promise<void> {
  try {
    const res = await fetch(`${ENGINE_URL}/api/extensions`, { credentials: 'include' });
    const data = await res.json();
    activeExtensions = data.extensions || [];
    extensionBundles = data.bundles || [];

    await loadExtensionBundles(extensionBundles);
    initialized = true;
  } catch (err) {
    console.error('Failed to load extensions:', err);
    initialized = true;
  }
}

// Load IIFE extension bundles via <script> tags.
// Dynamic import() is NOT used because:
//   1. IIFE bundles reference globals (window.__SvelteRuntime.*), not ESM exports
//   2. script tags work with same-origin CSP without 'unsafe-inline'
//   3. No risk of duplicate Svelte runtime instances
async function loadExtensionBundles(
  bundles: Array<{ name: string; url: string }>,
): Promise<void> {
  await Promise.allSettled(bundles.map((bundle) => loadBundle(bundle)));
}

function loadBundle(bundle: { name: string; url: string }): Promise<void> {
  return new Promise((resolve) => {
    const scriptId = `zveltio-ext-${bundle.name.replace(/[^a-z0-9]/gi, '-')}`;

    // Already loaded — idempotent
    if (document.getElementById(scriptId)) {
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.id = scriptId;
    script.src = `${ENGINE_URL}${bundle.url}`;
    script.type = 'text/javascript'; // plain script, not "module" — required for IIFE
    script.dataset.zveltioExt = bundle.name;

    script.onload = () => {
      console.log(`🔌 Extension UI loaded: ${bundle.name}`);
      resolve();
    };

    script.onerror = (err) => {
      console.error(`❌ Extension UI failed to load: ${bundle.name}`, err);
      resolve(); // don't block other extensions
    };

    document.head.appendChild(script);
  });
}

export const extensions = {
  get active() { return activeExtensions; },
  get initialized() { return initialized; },
  isActive: (name: string) => activeExtensions.includes(name),
  hasCategory: (category: string) => activeExtensions.some((e) => e.startsWith(category)),
};
