<script lang="ts">
/**
 * CRM receivables card — dashboard slot contribution.
 *
 * Session-only briefing (`GET /ext/crm/briefing`): intentionally not gated on
 * `crm:read` so admins see amounts before granting themselves the CRM resource.
 */
import { base } from '$app/paths';
import { AlertCircle } from '@lucide/svelte';
import { api } from '$lib/api.js';
import { m } from '$lib/paraglide/messages.js';

type OverdueBucket = { currency: string; count: number; total: number };

let loading = $state(true);
let owed = $state<{
  overdue: OverdueBucket[];
  oldestOverdueDays: number | null;
  dueSoon: OverdueBucket[];
} | null>(null);

async function loadBriefing(): Promise<void> {
  loading = true;
  try {
    const r = await api.get<{ receivables?: typeof owed }>('/ext/crm/briefing');
    owed = r?.receivables ?? null;
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
    href="{base}/crm"
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
