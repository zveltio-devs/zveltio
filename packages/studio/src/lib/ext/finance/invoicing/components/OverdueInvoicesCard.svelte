<script lang="ts">
/**
 * Invoicing overdue summary — dashboard.widgets slot (Model 2.5).
 */
import { resolve } from '$app/paths';
import { FileWarning } from '@lucide/svelte';
import { m } from '#lib/i18n.svelte.js';
import { api } from '#lib/api.js';

type Stats = { overdue_count: number; outstanding: number };

let stats = $state<Stats | null>(null);

/**
 * What is still owed on sent, overdue and partly paid invoices, read as the
 * viewer, page by page, summed in cents so float drift never shows.
 */
async function loadStats(): Promise<void> {
  try {
    const filter = encodeURIComponent(JSON.stringify({ status: { in: ['sent', 'overdue', 'partially_paid'] } }));
    const limit = 500;
    let overdue = 0;
    let cents = 0;
    for (let page = 1; ; page++) {
      const r = await api.get<{ records?: { status: string; total: unknown; amount_paid: unknown }[] }>(
        `/api/data/invoices?filter=${filter}&sort=id&count=none&limit=${limit}&page=${page}`,
      );
      const rows = r.records ?? [];
      for (const i of rows) {
        if (i.status === 'overdue') overdue++;
        cents += Math.round(Number(i.total ?? 0) * 100) - Math.round(Number(i.amount_paid ?? 0) * 100);
      }
      if (rows.length < limit) break;
    }
    stats = { overdue_count: overdue, outstanding: cents / 100 };
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
    href={resolve('finance/invoicing')}
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
