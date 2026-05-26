<script lang="ts">
import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
import { m } from '$lib/i18n.svelte.js';
import { api } from '$lib/api.js';
const API = '/ext/operations/traceability';

let orders = $state<any[]>([]);
let loading = $state(true);
let error = $state('');
let statusFilter = $state('');
let showNewForm = $state(false);

let items = $state<any[]>([]);
let recipes = $state<any[]>([]);
let lots = $state<any[]>([]);

let newOrder = $state({
  output_item_id: '',
  recipe_id: '',
  planned_quantity: '',
  unit: 'kg' as string,
  notes: '',
});

let selectedOrder = $state<any>(null);
let consumeForm = $state({ lot_id: '', quantity_used: '' });
let haccpForm = $state({ ccp: '', value: '', unit: '°C', limit_min: '', ok: true });
let processing = $state(false);

$effect(() => {
  loadOrders();
  api
    .fetch(`${API}/items?type=finished`)
    .then((r) => r.json())
    .then((d) => {
      items = d.data ?? [];
    });
  api
    .fetch(`${API}/production/recipes`)
    .then((r) => r.json())
    .then((d) => {
      recipes = d.data ?? [];
    });
});

$effect(() => {
  statusFilter;
  loadOrders();
});

async function loadOrders() {
  loading = true;
  try {
    const params = new URLSearchParams();
    if (statusFilter) params.set('status', statusFilter);
    const res = await api.fetch(`${API}/production?${params}`);
    orders = res.ok ? (await res.json()).data : [];
  } finally {
    loading = false;
  }
}

async function loadAvailableLots(itemId: string) {
  const res = await api.fetch(`${API}/lots?status=available&limit=200`);
  lots = res.ok ? (await res.json()).data : [];
}

async function createOrder(e: Event) {
  e.preventDefault();
  processing = true;
  error = '';
  try {
    const res = await api.fetch(`${API}/production`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        output_item_id: newOrder.output_item_id,
        recipe_id: newOrder.recipe_id || undefined,
        planned_quantity: parseFloat(newOrder.planned_quantity),
        unit: newOrder.unit,
        notes: newOrder.notes || undefined,
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    showNewForm = false;
    await loadOrders();
  } catch (e: any) {
    error = e.message;
  } finally {
    processing = false;
  }
}

async function startOrder(id: string) {
  await api.fetch(`${API}/production/${id}/start`, { method: 'PATCH' });
  await loadOrders();
  if (selectedOrder?.id === id) await loadOrder(id);
}

async function loadOrder(id: string) {
  const res = await api.fetch(`${API}/production/${id}`);
  if (res.ok) {
    selectedOrder = (await res.json()).data;
    await loadAvailableLots(selectedOrder.output_lot_id);
  }
}

async function addConsumption(e: Event) {
  e.preventDefault();
  processing = true;
  error = '';
  try {
    const res = await api.fetch(`${API}/production/${selectedOrder.id}/consume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lot_id: consumeForm.lot_id,
        quantity_used: parseFloat(consumeForm.quantity_used),
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    consumeForm = { lot_id: '', quantity_used: '' };
    await loadOrder(selectedOrder.id);
  } catch (e: any) {
    error = e.message;
  } finally {
    processing = false;
  }
}

async function addHACCP(e: Event) {
  e.preventDefault();
  processing = true;
  try {
    await api.fetch(`${API}/production/${selectedOrder.id}/haccp`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        check: {
          ccp: haccpForm.ccp,
          value: parseFloat(haccpForm.value),
          unit: haccpForm.unit,
          limit_min: haccpForm.limit_min ? parseFloat(haccpForm.limit_min) : undefined,
          ok: haccpForm.ok,
          checked_at: new Date().toISOString(),
        },
      }),
    });
    haccpForm = { ccp: '', value: '', unit: '°C', limit_min: '', ok: true };
    await loadOrder(selectedOrder.id);
  } finally {
    processing = false;
  }
}

function statusBadge(s: string) {
  return (
    {
      draft: 'badge-ghost',
      in_progress: 'badge-warning',
      completed: 'badge-success',
      cancelled: 'badge-error',
    }[s] ?? 'badge-ghost'
  );
}
</script>

<ExtensionPageShell title={m['operations.traceability.production.title']()}>
  {#snippet actions()}
    <button class="btn btn-primary btn-sm" onclick={() => (showNewForm = true)}>{m['operations.traceability.production.newOrder']()}</button>
  {/snippet}
  <div class="p-6 space-y-4 pt-0">
{#if error}
    <div class="alert alert-error">{error}</div>
  {/if}

  {#if showNewForm}
    <div class="card bg-base-200 p-4">
      <h3 class="font-bold mb-3">{m['operations.traceability.ui.ordin_nou_de_produc_ie']()}</h3>
      <form onsubmit={createOrder} class="grid grid-cols-2 gap-3">
        <div class="col-span-2">
          <label class="label-text font-medium">{m['operations.traceability.production.finishedProduct']()}</label>
          <select class="select select-bordered w-full" bind:value={newOrder.output_item_id} required>
            <option value="">{m['operations.traceability.ui.selecta_i_produsul']()}</option>
            {#each items as item}
              <option value={item.id}>{item.name}</option>
            {/each}
          </select>
        </div>
        <div>
          <label class="label-text">{m['operations.traceability.production.recipe']()}</label>
          <select class="select select-bordered w-full" bind:value={newOrder.recipe_id}>
            <option value="">—</option>
            {#each recipes as r}
              <option value={r.id}>{r.name} v{r.version}</option>
            {/each}
          </select>
        </div>
        <div>
          <label class="label-text">{m['operations.traceability.production.plannedQty']()}</label>
          <div class="flex gap-2">
            <input type="number" class="input input-bordered flex-1" min="0.001" step="0.001" bind:value={newOrder.planned_quantity} required />
            <select class="select select-bordered w-24" bind:value={newOrder.unit}>
              {#each ['kg','g','l','ml','buc','cutie','sac','palet'] as u}
                <option value={u}>{u}</option>
              {/each}
            </select>
          </div>
        </div>
        <div class="col-span-2 flex justify-end gap-2">
          <button type="button" class="btn btn-ghost btn-sm" onclick={() => (showNewForm = false)}>{m['common.cancel']()}</button>
          <button type="submit" class="btn btn-primary btn-sm" disabled={processing}>{m['operations.traceability.ui.creeaz']()}</button>
        </div>
      </form>
    </div>
  {/if}

  <div class="flex gap-3">
    <select class="select select-bordered select-sm" bind:value={statusFilter}>
      <option value="">{m['operations.traceability.ui.toate']()}</option>
      <option value="draft">{m['common.status.draft']()}</option>
      <option value="in_progress">{m['operations.traceability.ui.n_execu_ie']()}</option>
      <option value="completed">{m['operations.traceability.ui.finalizat']()}</option>
    </select>
  </div>

  <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
    <div class="overflow-x-auto">
      <table class="table table-sm w-full">
        <thead><tr><th>{m['operations.traceability.production.col.number']()}</th><th>{m['operations.traceability.production.col.finished']()}</th><th>{m['common.col.status']()}</th><th>{m['operations.traceability.production.col.qty']()}</th><th></th></tr></thead>
        <tbody>
          {#each orders as order}
            <tr class={selectedOrder?.id === order.id ? 'bg-primary/10' : ''}>
              <td class="font-mono text-xs">{order.order_number}</td>
              <td class="text-sm">{order.output_item_name ?? '—'}</td>
              <td><span class="badge badge-sm {statusBadge(order.status)}">{order.status}</span></td>
              <td class="text-sm">{order.planned_quantity} {order.unit}</td>
              <td>
                <button class="btn btn-ghost btn-xs" onclick={() => loadOrder(order.id)}>{m['common.open']()}</button>
              </td>
            </tr>
          {/each}
          {#if orders.length === 0 && !loading}
            <tr><td colspan="5" class="text-center opacity-50 py-4">{m['operations.traceability.ui.niciun_ordin']()}</td></tr>
          {/if}
        </tbody>
      </table>
    </div>

    {#if selectedOrder}
      <div class="space-y-3">
        <div class="card bg-base-200 p-4">
          <div class="flex items-center justify-between mb-2">
            <h3 class="font-bold font-mono">{selectedOrder.order_number}</h3>
            <span class="badge {statusBadge(selectedOrder.status)}">{selectedOrder.status}</span>
          </div>
          {#if selectedOrder.status === 'draft'}
            <button class="btn btn-warning btn-sm w-full" onclick={() => startOrder(selectedOrder!.id)}>{m['operations.traceability.production.start']()}</button>
          {/if}
        </div>

        {#if selectedOrder.status === 'in_progress'}
          <!-- Consumption entry -->
          <div class="card bg-base-200 p-4">
            <h4 class="font-semibold mb-2">{m['operations.traceability.production.consume']()}</h4>
            <form onsubmit={addConsumption} class="flex gap-2">
              <select class="select select-bordered select-sm flex-1" bind:value={consumeForm.lot_id} required>
                <option value="">{m['operations.traceability.ui.selecta_i_lot']()}</option>
                {#each lots as lot}
                  <option value={lot.id}>{lot.lot_number} — {lot.item_name} ({lot.quantity_remaining} {lot.unit})</option>
                {/each}
              </select>
              <input type="number" class="input input-bordered input-sm w-24" placeholder={m['operations.traceability.ui.cant']()} min="0.001" step="0.001" bind:value={consumeForm.quantity_used} required />
              <button type="submit" class="btn btn-primary btn-sm" disabled={processing}>+</button>
            </form>
          </div>

          <!-- HACCP inline -->
          <div class="card bg-base-200 p-4">
            <h4 class="font-semibold mb-2">{m['operations.traceability.production.haccp']()}</h4>
            <form onsubmit={addHACCP} class="grid grid-cols-2 gap-2">
              <input type="text" class="input input-bordered input-sm col-span-2" placeholder={m['operations.traceability.ui.punct_ccp_ex_temperatura_coacere']()} bind:value={haccpForm.ccp} required />
              <div class="flex gap-1">
                <input type="number" class="input input-bordered input-sm flex-1" placeholder={m['operations.traceability.ui.valoare']()} step="0.1" bind:value={haccpForm.value} required />
                <input type="text" class="input input-bordered input-sm w-16" placeholder={m['operations.traceability.dispatches.um']()} bind:value={haccpForm.unit} />
              </div>
              <div class="flex items-center gap-2">
                <input type="number" class="input input-bordered input-sm w-24" placeholder={m['operations.traceability.ui.limit_min']()} step="0.1" bind:value={haccpForm.limit_min} />
                <label class="flex items-center gap-1 cursor-pointer">
                  <input type="checkbox" class="checkbox checkbox-success checkbox-sm" bind:checked={haccpForm.ok} />
                  <span class="text-sm">OK</span>
                </label>
              </div>
              <button type="submit" class="btn btn-sm btn-success col-span-2" disabled={processing}>{m['operations.traceability.ui.nregistreaz_ccp']()}</button>
            </form>
          </div>
        {/if}

        <!-- Consumptions list -->
        {#if selectedOrder.consumptions?.length}
          <div class="card bg-base-200 p-4">
            <h4 class="font-semibold mb-2">Consumuri ({selectedOrder.consumptions.length})</h4>
            <div class="space-y-1">
              {#each selectedOrder.consumptions as c}
                <div class="text-sm flex justify-between">
                  <span class="font-mono">{c.lot_number}</span>
                  <span>{c.item_name}</span>
                  <span class="font-medium">{c.quantity_used} {c.unit}</span>
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <!-- HACCP checks -->
        {#if selectedOrder.haccp_checks?.length}
          <div class="card bg-base-200 p-4">
            <h4 class="font-semibold mb-2">Verificări CCP ({selectedOrder.haccp_checks.length})</h4>
            {#each selectedOrder.haccp_checks as check}
              <div class="flex items-center gap-2 text-sm py-1 border-b border-base-300">
                <span class={check.ok ? 'text-success' : 'text-error'}>{check.ok ? '✓' : '✗'}</span>
                <span>{check.ccp}: <strong>{check.value} {check.unit}</strong></span>
                {#if check.limit_min}<span class="opacity-60">min {check.limit_min}</span>{/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
  </div>
</ExtensionPageShell>
