/**
 * Compile-time Studio contributions for AI.
 *
 * Synced to `$lib/ext/ai/contribute.ts` by `sync-extensions.ts`.
 */
import { registerContributionSlot } from '$lib/extension-api.svelte.js';
import AiPromptBar from './components/AiPromptBar.svelte';

const OWNER = 'ai';

export function activate(): void {
  registerContributionSlot(OWNER, 'topbar.center', {
    component: AiPromptBar,
    priority: 10,
  });
}
