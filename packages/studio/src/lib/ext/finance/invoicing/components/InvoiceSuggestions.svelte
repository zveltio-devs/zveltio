<script lang="ts">
/**
 * Invoicing suggestions strip — Model 2.5 `dashboard.suggestions` slot.
 */
import { base } from '$app/paths';
import { Lightbulb } from '@lucide/svelte';
import { api } from '$lib/api.js';
import { m } from '$lib/i18n.svelte.js';

type Stats = {
  overdue_count?: number | string;
  outstanding?: number | string;
};

let stats = $state<Stats | null>(null);

async function loadStats(): Promise<void> {
  try {
    const r = await api.get<{ data?: Stats }>('/ext/finance/invoicing/invoices/stats');
    stats = r.data ?? null;
  } catch {
    stats = null;
  }
}

$effect(() => {
  void loadStats();
});

const overdueCount = $derived(Number(stats?.overdue_count ?? 0));
</script>

{#if overdueCount > 0}
  <a
    href="{base}/finance/invoicing"
    class="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 hover:border-warning/60 transition-colors"
    data-testid="invoicing-dashboard-suggestion"
  >
    <Lightbulb class="w-5 h-5 text-warning shrink-0 mt-0.5" />
    <div class="min-w-0 text-sm">
      <div class="font-medium">
        {m['invoicing.suggestions.overdueTitle']?.({ count: overdueCount }) ??
          `${overdueCount} overdue invoice${overdueCount === 1 ? '' : 's'}`}
      </div>
      <div class="text-base-content/65">
        {m['invoicing.suggestions.overdueHint']?.() ??
          'Review and send reminders from Invoicing.'}
      </div>
    </div>
  </a>
{/if}
