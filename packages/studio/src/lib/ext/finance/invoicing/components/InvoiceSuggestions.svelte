<script lang="ts">
/**
 * Invoicing suggestions strip — Model 2.5 `dashboard.suggestions` slot.
 */
import { resolve } from '$app/paths';
import { Lightbulb } from '@lucide/svelte';
import { m } from '#lib/i18n.svelte.js';
import { api } from '#lib/api.js';

let overdueCount = $state(0);

async function loadStats(): Promise<void> {
  try {
    const r = await api.get<{ records?: unknown[] }>('/api/data/invoices?status[eq]=overdue&limit=500');
    overdueCount = r.records?.length ?? 0;
  } catch {
    overdueCount = 0;
  }
}

$effect(() => {
  void loadStats();
});

</script>

{#if overdueCount > 0}
  <a
    href={resolve('finance/invoicing')}
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
