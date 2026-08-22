/**
 * Compile-time Studio contributions for Invoicing.
 *
 * Synced to `$lib/ext/finance/invoicing/contribute.ts` by `sync-extensions.ts`.
 */
import { registerContributionSlot } from '$lib/extension-api.svelte.js';
import InvoiceSuggestions from './components/InvoiceSuggestions.svelte';
import OverdueInvoicesCard from './components/OverdueInvoicesCard.svelte';

const OWNER = 'finance/invoicing';

export function activate(): void {
  registerContributionSlot(OWNER, 'dashboard.widgets', {
    component: OverdueInvoicesCard,
    priority: 8,
  });
  registerContributionSlot(OWNER, 'dashboard.suggestions', {
    component: InvoiceSuggestions,
    priority: 8,
  });
}
