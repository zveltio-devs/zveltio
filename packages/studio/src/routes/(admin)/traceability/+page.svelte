<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
import { api } from '$lib/api.js';
const API = '/ext/operations/traceability';

let lots = $state<any[]>([]);
let loading = $state(true);
let error = $state('');
let search = $state('');
let statusFilter = $state('');
let page = $state(1);
let total = $state(0);
const limit = 50;

const totalPages = $derived(Math.ceil(total / limit));

async function load() {
  loading = true;
  error = '';
  try {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (statusFilter) params.set('status', statusFilter);
    const res = await api.fetch(`${API}/lots?${params}`);
    if (!res.ok) throw new Error(await res.text());
    const json = await res.json();
    lots = json.data;
    total = json.meta.total;
  } catch (e: any) {
    error = e.message;
  } finally {
    loading = false;
  }
}

$effect(() => {
  load();
});

$effect(() => {
  page;
  statusFilter;
  load();
});

function statusClass(status: string): string {
  return (
    {
      available: 'badge-success',
      quarantine: 'badge-warning',
      exhausted: 'badge-neutral',
      recalled: 'badge-error',
      returned: 'badge-info',
    }[status] ?? 'badge-ghost'
  );
}

function daysUntilExpiry(date: string): number {
  if (!date) return 999;
  return Math.ceil((new Date(date).getTime() - Date.now()) / 86400000);
}
</script>

<ExtensionPageShell title={m['operations.traceability.title']()} subtitle={m['operations.traceability.subtitle']()}>
<div class="flex gap-3 flex-wrap">
    <select class="select select-bordered select-sm" bind:value={statusFilter}>
      <option value="">{m['operations.traceability.ui.toate_statusurile']()}</option>
      <option value="quarantine">{m['operations.traceability.ui.carantin']()}</option>
      <option value="available">{m['operations.traceability.ui.disponibil']()}</option>
      <option value="exhausted">{m['operations.traceability.ui.epuizat']()}</option>
      <option value="recalled">{m['operations.traceability.ui.retras']()}</option>
    </select>
</div>

{#if error}
    <div class="alert alert-error">{error}</div>
  {/if}

  {#if loading}
    <div class="flex justify-center py-12">
      <span class="loading loading-spinner loading-lg"></span>
    </div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-zebra w-full">
        <thead>
          <tr>
            <th>{m['operations.traceability.col.lotNumber']()}</th>
            <th>{m['operations.traceability.col.product']()}</th>
            <th>{m['operations.traceability.col.supplier']()}</th>
            <th>{m['common.col.status']()}</th>
            <th>{m['operations.traceability.col.qtyRemaining']()}</th>
            <th>{m['operations.traceability.col.expiry']()}</th>
            <th>{m['operations.traceability.col.location']()}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each lots as lot}
            {@const days = daysUntilExpiry(lot.best_before_date)}
            <tr class={days <= 3 && lot.status === 'available' ? 'bg-error/10' : days <= 7 && lot.status === 'available' ? 'bg-warning/10' : ''}>
              <td class="font-mono text-sm">{lot.lot_number}</td>
              <td>
                <div class="font-medium">{lot.item_name}</div>
                <div class="text-xs text-base-content/50">{lot.item_code}</div>
              </td>
              <td class="text-sm">{lot.supplier_name ?? '—'}</td>
              <td>
                <span class="badge {statusClass(lot.status)} badge-sm">{lot.status}</span>
              </td>
              <td class="text-sm">{lot.quantity_remaining} {lot.unit}</td>
              <td class="text-sm">
                {#if lot.best_before_date}
                  <span class={days <= 3 ? 'text-error font-bold' : days <= 7 ? 'text-warning' : ''}>
                    {lot.best_before_date}
                  </span>
                {:else}
                  —
                {/if}
              </td>
              <td class="text-xs">{[lot.warehouse, lot.row, lot.shelf].filter(Boolean).join(' / ') || '—'}</td>
              <td>
                <a href="/admin/trace/lots/{lot.id}" class="btn btn-ghost btn-xs">{m['operations.traceability.action.details']()}</a>
              </td>
            </tr>
          {/each}
          {#if lots.length === 0}
            <tr><td colspan="8" class="text-center text-base-content/50 py-8">{m['operations.traceability.ui.niciun_lot_g_sit']()}</td></tr>
          {/if}
        </tbody>
      </table>
    </div>

    {#if totalPages > 1}
      <div class="flex justify-center gap-2">
        <button class="btn btn-sm" onclick={() => page--} disabled={page === 1}>‹</button>
        <span class="flex items-center px-3 text-sm">{m['operations.traceability.pageOf']({ page: String(page), total: String(totalPages) })}</span>
        <button class="btn btn-sm" onclick={() => page++} disabled={page === totalPages}>›</button>
      </div>
    {/if}
  {/if}
</ExtensionPageShell>
