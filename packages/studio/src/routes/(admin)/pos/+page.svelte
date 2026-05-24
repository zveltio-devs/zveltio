<script lang="ts">
  import { m } from '$lib/i18n.svelte.js';
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
      import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { ScanLine, Play, Square, Receipt, LoaderCircle } from '@lucide/svelte';

  let activeSession = $state<any>(null);
  let recentOrders = $state<any[]>([]);
  let zReports = $state<any[]>([]);
  let loading = $state(true);
  let openingFloat = $state(0);
  let closingFloat = $state(0);

  async function loadAll() {
    loading = true;
    try {
      const [active, orders, reports] = await Promise.all([
        api.get<{ data: any }>('/ext/operations/pos/sessions/active').catch(() => ({ data: null })),
        api.get<{ data: any[] }>('/ext/operations/pos/orders?limit=20'),
        api.get<{ data: any[] }>('/ext/operations/pos/z-reports?limit=10').catch(() => ({ data: [] })),
      ]);
      activeSession = active.data;
      recentOrders = orders.data ?? [];
      zReports = reports.data ?? [];
    } catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.loadFailed']()); }
    finally { loading = false; }
  }

  async function openSession() {
    try {
      await api.post('/ext/operations/pos/sessions/open', { opening_float: openingFloat });
      await loadAll();
      toast.success(m['operations.pos.toast.sessionOpened']());
    } catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.saveFailed']()); }
  }

  async function closeSession() {
    if (!activeSession) return;
    try {
      await api.post(`/ext/operations/pos/sessions/${activeSession.id}/close`, { closing_float: closingFloat });
      await loadAll();
      toast.success(m['operations.pos.toast.sessionClosed']());
    } catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.saveFailed']()); }
  }

  onMount(loadAll);

  function fmtMoney(n: number) { return new Intl.NumberFormat('ro-RO', { style: 'currency', currency: 'RON' }).format(n); }
</script>

<ExtensionPageShell title={m['operations.pos.title']()} subtitle={m['operations.pos.subtitle']()}>
  {#snippet children()}
{#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else}
    <div class="card bg-base-200 border border-base-300">
      <div class="card-body p-4">
        {#if activeSession}
          <div class="flex items-center justify-between flex-wrap gap-3">
            <div>
              <div class="badge badge-success badge-sm mb-1">{m['operations.pos.session.open']()}</div>
              <div class="font-medium text-sm">{new Date(activeSession.opened_at).toLocaleString()}</div>
              <div class="text-xs text-base-content/60">{m['operations.pos.session.openingFloat']()} {fmtMoney(Number(activeSession.opening_float))}</div>
            </div>
            <div class="flex items-center gap-2">
              <input type="number" step="0.01" placeholder={m['operations.pos.ui.closing_float']()} class="input input-sm w-36" bind:value={closingFloat} />
              <button class="btn btn-error btn-sm gap-1" onclick={closeSession}><Square size={14} /> {m['operations.pos.closeSession']()}</button>
            </div>
          </div>
        {:else}
          <div class="flex items-center justify-between flex-wrap gap-3">
            <p class="text-sm text-base-content/60">{m['operations.pos.session.noOpen']()}</p>
            <div class="flex items-center gap-2">
              <input type="number" step="0.01" placeholder={m['operations.pos.ui.opening_float']()} class="input input-sm w-36" bind:value={openingFloat} />
              <button class="btn btn-primary btn-sm gap-1" onclick={openSession}><Play size={14} /> {m['operations.pos.openSession']()}</button>
            </div>
          </div>
        {/if}
      </div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div class="card bg-base-200 border border-base-300">
        <div class="card-body p-0">
          <div class="p-3 font-medium text-sm border-b border-base-300 flex items-center gap-2"><Receipt size={14} /> {m['operations.pos.recentOrders']()}</div>
          <div class="overflow-x-auto">
            <table class="table table-sm">
              <thead><tr><th>{m['common.col.number']()}</th><th>{m['operations.pos.col.time']()}</th><th class="text-right">{m['common.col.total']()}</th><th>{m['common.col.status']()}</th></tr></thead>
              <tbody>
                {#if recentOrders.length === 0}<tr><td colspan="4" class="text-center py-6 text-base-content/50 text-sm">{m['operations.pos.ui.no_orders_yet']()}</td></tr>
                {:else}{#each recentOrders as o (o.id)}
                  <tr class="hover"><td class="font-mono text-xs">{o.order_number}</td><td class="text-xs">{new Date(o.created_at).toLocaleTimeString()}</td><td class="text-right text-sm">{fmtMoney(Number(o.total))}</td><td><span class="badge badge-sm badge-ghost">{o.status}</span></td></tr>
                {/each}{/if}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="card bg-base-200 border border-base-300">
        <div class="card-body p-0">
          <div class="p-3 font-medium text-sm border-b border-base-300">{m['operations.pos.zReports']()}</div>
          <div class="overflow-x-auto">
            <table class="table table-sm">
              <thead><tr><th>{m['common.col.date']()}</th><th class="text-right">{m['operations.pos.col.sales']()}</th><th class="text-right">{m['operations.pos.col.orderCount']()}</th></tr></thead>
              <tbody>
                {#if zReports.length === 0}<tr><td colspan="3" class="text-center py-6 text-base-content/50 text-sm">{m['operations.pos.ui.no_reports']()}</td></tr>
                {:else}{#each zReports as z (z.id)}
                  <tr class="hover"><td class="text-xs">{new Date(z.created_at).toLocaleDateString()}</td><td class="text-right text-sm">{fmtMoney(Number(z.total_sales))}</td><td class="text-right text-sm">{z.order_count}</td></tr>
                {/each}{/if}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  {/if}
  {/snippet}
</ExtensionPageShell>
