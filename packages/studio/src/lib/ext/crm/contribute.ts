/**
 * Compile-time Studio contributions for CRM.
 *
 * Synced to `$lib/ext/crm/contribute.ts` by `sync-extensions.ts`. Loaded when
 * `crm` is in `GET /api/extensions` active list.
 */
import { registerContributionSlot } from '$lib/extension-api.svelte.js';
import ReceivablesCard from './components/ReceivablesCard.svelte';

const OWNER = 'crm';

export function activate(): void {
  registerContributionSlot(OWNER, 'dashboard.widgets', {
    component: ReceivablesCard,
    priority: 5,
  });
}
