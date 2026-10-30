<script lang="ts">
/**
 * CRM receivables card — dashboard slot contribution.
 *
 * Reads open invoices through the data API, so it shows only what the caller
 * may read on `transactions`; without that right the card stays empty.
 */
import { resolve } from '$app/paths';
import { AlertCircle } from '@lucide/svelte';
import { api } from '#lib/api.js';
// `$lib/i18n.svelte.js`, like the other 74 callers. Paraglide emits plain
// `.js` with no declarations, so importing its output directly makes every
// message key `any`; the host re-exports the same object from a TypeScript
// module, which is where the types come from.
import { m } from '#lib/i18n.svelte.js';

type OverdueBucket = { currency: string; count: number; total: number };

let loading = $state(true);
let owed = $state<{
  overdue: OverdueBucket[];
  oldestOverdueDays: number | null;
  dueSoon: OverdueBucket[];
} | null>(null);

type Invoice = { currency: string; total_amount: number | string; due_date: string };

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

function buckets(rows: Invoice[]): OverdueBucket[] {
  const by = new Map<string, OverdueBucket>();
  for (const r of rows) {
    const b = by.get(r.currency) ?? { currency: r.currency, count: 0, total: 0 };
    b.count += 1;
    b.total += Number(r.total_amount) || 0;
    by.set(r.currency, b);
  }
  return [...by.values()].sort((x, y) => y.total - x.total);
}

// ponytail: one page of 500 open invoices due within a week; a firm with more
// sees a partial sum. Upgrade path: an aggregate read in the data API.
async function loadBriefing(): Promise<void> {
  loading = true;
  try {
    const today = day(0);
    const r = await api.get<{ records?: Invoice[] }>(
      `/api/data/transactions?type[eq]=invoice&status[not_in]=completed,cancelled,refunded&due_date[lte]=${day(7)}&limit=500`,
    );
    const rows = r?.records ?? [];
    const overdue = rows.filter((x) => x.due_date < today);
    const oldest = overdue.reduce<string | null>((o, x) => (o === null || x.due_date < o ? x.due_date : o), null);
    owed = {
      overdue: buckets(overdue),
      oldestOverdueDays: oldest ? Math.round((Date.parse(today) - Date.parse(oldest)) / 86_400_000) : null,
      dueSoon: buckets(rows.filter((x) => x.due_date >= today)),
    };
  } catch {
    owed = null;
  } finally {
    loading = false;
  }
}

$effect(() => {
  void loadBriefing();
});

const owedTotals = $derived(
  (owed?.overdue ?? []).map(
    (b) => `${new Intl.NumberFormat().format(Math.round(b.total))} ${b.currency}`,
  ),
);
const owedCount = $derived((owed?.overdue ?? []).reduce((n, b) => n + b.count, 0));
const dueSoonCount = $derived((owed?.dueSoon ?? []).reduce((n, b) => n + b.count, 0));
</script>

{#if loading}
  <div
    class="card bg-base-100 border border-base-300"
    data-testid="crm-receivables-widget"
    aria-busy="true"
    aria-label={m['briefing.owedTitle']()}
  >
    <div class="card-body flex-row items-center gap-4 py-4">
      <div class="animate-shimmer w-8 h-8 rounded-full shrink-0"></div>
      <div class="min-w-0 flex-1 space-y-2">
        <div class="animate-shimmer h-3 w-32 rounded-md"></div>
        <div class="animate-shimmer h-7 w-48 rounded-md"></div>
        <div class="animate-shimmer h-3 w-56 rounded-md"></div>
      </div>
    </div>
  </div>
{:else if owedCount > 0}
  <a
    href={resolve('crm')}
    class="card bg-base-100 border border-warning/40 hover:border-warning transition-colors"
    data-testid="crm-receivables-widget"
    aria-label={m['briefing.owedTitle']()}
  >
    <div class="card-body flex-row items-center gap-4 py-4">
      <AlertCircle class="w-8 h-8 text-warning shrink-0" />
      <div class="min-w-0">
        <div class="text-sm opacity-70">{m['briefing.owedTitle']()}</div>
        <div class="text-2xl font-semibold truncate">{owedTotals.join(' · ')}</div>
        <div class="text-sm opacity-70">
          {m['briefing.overdueCount']({ count: owedCount })}{owed?.oldestOverdueDays
            ? `, ${m['briefing.oldestDays']({ days: owed.oldestOverdueDays })}`
            : ''}{dueSoonCount > 0
            ? ` · ${m['briefing.dueSoon']({ count: dueSoonCount })}`
            : ''}
        </div>
      </div>
    </div>
  </a>
{:else}
  <!-- Always mount so e2e / a11y can find the contribution even with zero overdue. -->
  <div
    class="sr-only"
    data-testid="crm-receivables-widget"
    aria-label={m['briefing.owedTitle']()}
  >
    {m['briefing.owedTitle']()}
  </div>
{/if}
