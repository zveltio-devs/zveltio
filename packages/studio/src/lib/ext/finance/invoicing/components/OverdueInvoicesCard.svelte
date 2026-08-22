<script lang="ts">
/**
 * Invoicing overdue summary — dashboard.widgets slot (Model 2.5).
 */
import { base } from '$app/paths';
import { FileWarning } from '@lucide/svelte';
import { api } from '$lib/api.js';
import { m } from '$lib/i18n.svelte.js';

type Stats = {
  outstanding?: number | string;
  overdue_count?: number | string;
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
const outstanding = $derived(Number(stats?.outstanding ?? 0));
</script>

{#if overdueCount > 0 || outstanding > 0}
  <a
    href="{base}/finance/invoicing"
    class="card bg-base-100 border border-error/30 hover:border-error/60 transition-colors"
  >
    <div class="card-body flex-row items-center gap-4 py-4">
      <FileWarning class="w-8 h-8 text-error shrink-0" />
      <div class="min-w-0">
        <div class="text-sm opacity-70">{m['invoicing.widget.title']?.() ?? 'Outstanding invoices'}</div>
        <div class="text-2xl font-semibold truncate">
          {new Intl.NumberFormat().format(Math.round(outstanding))}
        </div>
        {#if overdueCount > 0}
          <div class="text-sm opacity-70">
            {m['invoicing.widget.overdueCount']?.({ count: overdueCount }) ??
              `${overdueCount} overdue`}
          </div>
        {/if}
      </div>
    </div>
  </a>
{/if}
