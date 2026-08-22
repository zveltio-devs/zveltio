<script lang="ts">
/**
 * CRM receivables card — dashboard slot contribution.
 *
 * Session-only briefing (`GET /ext/crm/briefing`): intentionally not gated on
 * `crm:read` so admins see amounts before granting themselves the CRM resource.
 */
import { base } from '$app/paths';
import { AlertCircle } from 'lucide-svelte';
import { api } from '$lib/api.js';
import { m } from '$lib/paraglide/messages.js';

type OverdueBucket = { currency: string; count: number; total: number };

let owed = $state<{
  overdue: OverdueBucket[];
  oldestOverdueDays: number | null;
  dueSoon: OverdueBucket[];
} | null>(null);

async function loadBriefing(): Promise<void> {
  try {
    const r = await api.get<{ receivables?: typeof owed }>('/ext/crm/briefing');
    owed = r?.receivables ?? null;
  } catch {
    owed = null;
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

{#if owedCount > 0}
  <a
    href="{base}/crm"
    class="card bg-base-100 border border-warning/40 hover:border-warning transition-colors"
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
{/if}
