/**
 * Loads compile-time extension contributions synced by `sync-extensions.ts`.
 *
 * Each enabled extension with `studio/src/contribute.ts` exports `activate()`,
 * which registers slot widgets via `registerContributionSlot`. Disabled
 * extensions are unregistered without a full page reload.
 */

import { CONTRIBUTION_MODULES } from '$lib/ext/.contributions.generated.js';
import { registerContributionSlot, unregisterContributions } from '$lib/extension-api.svelte.js';

type ContributionModules = Record<string, () => Promise<{ activate?: () => void }>>;

/** Extensions whose `activate()` already ran this session (guards HMR double-call). */
const activated = new Set<string>();

export async function loadExtensionContributions(
  active: string[],
  modules: ContributionModules = CONTRIBUTION_MODULES,
): Promise<void> {
  const activeSet = new Set(active);

  for (const name of [...activated]) {
    if (!activeSet.has(name)) {
      unregisterContributions(name);
      activated.delete(name);
    }
  }

  for (const name of active) {
    const load = modules[name];
    if (!load) continue;
    if (activated.has(name)) continue;

    try {
      unregisterContributions(name);
      const mod = await load();
      mod.activate?.();
      activated.add(name);
    } catch (err) {
      console.error(`[contributions] failed to activate "${name}":`, err);
    }
  }
}

/** Test-only: reset activation guard between unit tests. */
export function _resetContributionLoaderForTests(): void {
  activated.clear();
}

/** Test-only: which extensions have activate() running this session. */
export function _activatedContributionsForTests(): ReadonlySet<string> {
  return activated;
}

// Re-export for contribute modules that prefer a stable import path.
export { registerContributionSlot, unregisterContributions };
