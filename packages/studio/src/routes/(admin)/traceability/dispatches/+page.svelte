<script lang="ts">
  import { m } from '$lib/i18n.svelte.js';
  import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
  import { createExtensionConfirm } from '$lib/utils/extension-confirm.svelte.js';
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import { api } from '$lib/api.js';
  const { confirmState, askConfirm, runConfirmAction, cancelConfirm } = createExtensionConfirm();

  const API = '/ext/operations/traceability';

  type Tab = 'pending' | 'confirmed' | 'direct';

  let activeTab = $state<Tab>('pending');
  let dispatches = $state<any[]>([]);
  let loading = $state(false);
  let error = $state('');

  let selected = $state<any>(null);
  let confirmForm = $state({ quantity_dispatched: '', notes: '' });
  let assignLotId = $state('');
  let lots = $state<any[]>([]);
  let confirming = $state(false);

  // Direct dispatch form
  let directForm = $state({
    lot_id: '',
    quantity_dispatched: '',
    unit: 'buc',
    customer_name: '',
    invoice_number: '',
    notes: '',
  });
  let directSaving = $state(false);
  let directDone = $state<any>(null);

  $effect(() => {
    activeTab;
    loadDispatches();
  });

  $effect(() => {
    if (activeTab === 'direct') {
      api.fetch(`${API}/lots?status=available&limit=200`)
        .then(r => r.json())
        .then(d => { lots = d.data ?? []; });
    }
  });

  async function loadDispatches() {
    loading = true;
    error = '';
    try {
      const status = activeTab === 'pending' ? 'pending' : activeTab === 'confirmed' ? 'confirmed' : null;
      const params = status ? `?status=${status}` : '';
      const res = await api.fetch(`${API}/dispatches${params}`);
      dispatches = res.ok ? (await res.json()).data : [];
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  async function selectDispatch(d: any) {
    const res = await api.fetch(`${API}/dispatches/${d.id}`);
    selected = res.ok ? (await res.json()).data : d;
    confirmForm = { quantity_dispatched: String(selected.quantity_invoiced ?? ''), notes: '' };
    assignLotId = selected.lot_id ?? '';
  }

  async function assignLot() {
    if (!assignLotId || !selected) return;
    const res = await api.fetch(`${API}/dispatches/${selected.id}/assign-lot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lot_id: assignLotId }),
    });
    if (res.ok) {
      selected = { ...selected, lot_id: assignLotId };
    } else {
      error = (await res.json()).error;
    }
  }

  async function confirm(e: Event) {
    e.preventDefault();
    confirming = true;
    error = '';
    try {
      const res = await api.fetch(`${API}/dispatches/${selected.id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quantity_dispatched: parseFloat(confirmForm.quantity_dispatched),
          notes: confirmForm.notes || undefined,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      selected = null;
      await loadDispatches();
    } catch (e: any) {
      error = e.message;
    } finally {
      confirming = false;
    }
  }

  async function cancelDispatch(id: string) {
        askConfirm(m['operations.traceability.confirmCancelDispatch'](), () => cancelDispatchConfirmed(id));
  }
  async function cancelDispatchConfirmed(id: string) {
    await api.fetch(`${API}/dispatches/${id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    selected = null;
    await loadDispatches();
  }


  async function submitDirect(e: Event) {
    e.preventDefault();
    directSaving = true;
    error = '';
    directDone = null;
    try {
      const res = await api.fetch(`${API}/dispatches/direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lot_id: directForm.lot_id,
          quantity_dispatched: parseFloat(directForm.quantity_dispatched),
          unit: directForm.unit,
          customer_name: directForm.customer_name,
          invoice_number: directForm.invoice_number || undefined,
          notes: directForm.notes || undefined,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      directDone = (await res.json()).data;
      directForm = { lot_id: '', quantity_dispatched: '', unit: 'buc', customer_name: '', invoice_number: '', notes: '' };
    } catch (e: any) {
      error = e.message;
    } finally {
      directSaving = false;
    }
  }
</script>

<ExtensionPageShell title={m['operations.traceability.dispatches.title']()}>
  <div class="p-6 space-y-4 pt-0">
  <div class="tabs tabs-bordered">
    <button class="tab {activeTab === 'pending' ? 'tab-active' : ''}" onclick={() => { activeTab = 'pending'; selected = null; }}>
      În așteptare
      {#if activeTab === 'pending' && dispatches.length > 0}
        <span class="badge badge-warning badge-sm ml-1">{dispatches.length}</span>
      {/if}
    </button>
    <button class="tab {activeTab === 'confirmed' ? 'tab-active' : ''}" onclick={() => { activeTab = 'confirmed'; selected = null; }}>
      Confirmate
    </button>
    <button class="tab {activeTab === 'direct' ? 'tab-active' : ''}" onclick={() => { activeTab = 'direct'; selected = null; }}>
      + Expediere directă
    </button>
  </div>

  {#if error}
    <div class="alert alert-error">{error}</div>
  {/if}

  {#if activeTab === 'direct'}
    <div class="max-w-lg">
      {#if directDone}
        <div class="alert alert-success mb-4">
          {m['operations.traceability.dispatches.directSuccess']()} <strong>{directDone.customer_name}</strong>.
          <button class="btn btn-sm btn-ghost ml-2" onclick={() => directDone = null}>{m['operations.traceability.dispatches.another']()}</button>
        </div>
      {/if}
      <form onsubmit={submitDirect} class="space-y-3">
        <div>
          <label class="label-text font-medium">{m['operations.traceability.dispatches.lot']()}</label>
          <select class="select select-bordered w-full" bind:value={directForm.lot_id} required>
            <option value="">{m['operations.traceability.ui.selecta_i_lot_disponibil']()}</option>
            {#each lots as lot}
              <option value={lot.id}>
                {lot.lot_number} — {lot.item_name} ({lot.quantity_remaining} {lot.unit})
                {lot.best_before_date ? ' BBD: ' + lot.best_before_date : ''}
              </option>
            {/each}
          </select>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="label-text font-medium">{m['operations.traceability.dispatches.qty']()}</label>
            <input type="number" class="input input-bordered w-full" min="0.001" step="0.001" bind:value={directForm.quantity_dispatched} required />
          </div>
          <div>
            <label class="label-text font-medium">{m['operations.traceability.dispatches.um']()}</label>
            <select class="select select-bordered w-full" bind:value={directForm.unit}>
              {#each ['kg','g','l','ml','buc','cutie','sac','palet'] as u}
                <option value={u}>{u}</option>
              {/each}
            </select>
          </div>
        </div>
        <div>
          <label class="label-text font-medium">{m['operations.traceability.dispatches.client']()}</label>
          <input type="text" class="input input-bordered w-full" bind:value={directForm.customer_name} required placeholder={m['operations.traceability.ui.denumire_client']()} />
        </div>
        <div>
          <label class="label-text font-medium">{m['operations.traceability.dispatches.invoice']()}</label>
          <input type="text" class="input input-bordered w-full" bind:value={directForm.invoice_number} placeholder={m['operations.traceability.ui.ex_inv_00123']()} />
        </div>
        <div>
          <label class="label-text font-medium">{m['operations.traceability.form.notes']()}</label>
          <textarea class="textarea textarea-bordered w-full" rows="2" bind:value={directForm.notes}></textarea>
        </div>
        <button type="submit" class="btn btn-primary w-full" disabled={directSaving}>
          {directSaving ? 'Se înregistrează...' : '✓ Înregistrează expedierea'}
        </button>
      </form>
    </div>
  {:else}
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <!-- List -->
      <div class="overflow-x-auto">
        {#if loading}
          <div class="flex justify-center py-8"><span class="loading loading-spinner"></span></div>
        {:else}
          <table class="table table-sm w-full">
            <thead>
              <tr>
                <th>{m['operations.traceability.dispatches.col.client']()}</th>
                <th>{m['operations.traceability.dispatches.col.productLot']()}</th>
                <th>{m['operations.traceability.dispatches.col.invoicedQty']()}</th>
                <th>{m['operations.traceability.dispatches.col.invoice']()}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {#each dispatches as d}
                <tr class={selected?.id === d.id ? 'bg-primary/10' : ''}>
                  <td class="text-sm font-medium">{d.customer_name ?? '—'}</td>
                  <td>
                    <div class="text-sm">{d.item_name_from_invoice ?? d.item_name ?? '?'}</div>
                    <div class="text-xs font-mono opacity-60">{d.lot_number ?? 'fără lot'}</div>
                  </td>
                  <td class="text-sm">{d.quantity_invoiced} {d.unit}</td>
                  <td class="text-xs opacity-60">{d.invoice_number ?? '—'}</td>
                  <td>
                    <button class="btn btn-ghost btn-xs" onclick={() => selectDispatch(d)}>
                      {activeTab === 'pending' ? 'Confirmă' : 'Detalii'}
                    </button>
                  </td>
                </tr>
              {/each}
              {#if dispatches.length === 0}
                <tr>
                  <td colspan="5" class="text-center opacity-50 py-6">
                    {activeTab === 'pending' ? 'Nicio expediere în așteptare' : 'Nicio expediere confirmată'}
                  </td>
                </tr>
              {/if}
            </tbody>
          </table>
        {/if}
      </div>

      <!-- Detail / confirm panel -->
      {#if selected}
        <div class="card bg-base-200 p-4 space-y-3">
          <h3 class="font-bold">{selected.customer_name}</h3>

          <div class="space-y-1 text-sm">
            <div class="flex justify-between">
              <span class="opacity-60">{m['operations.traceability.dispatches.billedProduct']()}</span>
              <span>{selected.item_name_from_invoice ?? '?'}</span>
            </div>
            <div class="flex justify-between">
              <span class="opacity-60">Lot</span>
              <span class="font-mono">{selected.lot_number ?? '—'}</span>
            </div>
            {#if selected.best_before_date}
              <div class="flex justify-between">
                <span class="opacity-60">{m['operations.traceability.dispatches.expiry']()}</span>
                <span class="font-medium">{selected.best_before_date}</span>
              </div>
            {/if}
            <div class="flex justify-between">
              <span class="opacity-60">{m['operations.traceability.dispatches.availableInLot']()}</span>
              <span class="font-bold">{selected.lot_qty_remaining} {selected.unit}</span>
            </div>
            <div class="flex justify-between">
              <span class="opacity-60">{m['operations.traceability.dispatches.invoicedQtyLabel']()}</span>
              <span>{selected.quantity_invoiced} {selected.unit}</span>
            </div>
            {#if selected.invoice_number}
              <div class="flex justify-between">
                <span class="opacity-60">{m['operations.traceability.dispatches.col.invoice']()}</span>
                <span class="font-mono">{selected.invoice_number}</span>
              </div>
            {/if}
          </div>

          {#if activeTab === 'pending'}
            <!-- Assign lot if missing -->
            {#if !selected.lot_id}
              <div class="alert alert-warning text-sm">
                Factura nu a avut lot specificat. Selectați lotul care se expediază:
              </div>
              <div class="flex gap-2">
                <select class="select select-bordered select-sm flex-1" bind:value={assignLotId}>
                  <option value="">{m['operations.traceability.ui.selecta_i_lot']()}</option>
                  {#each lots as lot}
                    <option value={lot.id}>{lot.lot_number} — {lot.item_name} ({lot.quantity_remaining} {lot.unit})</option>
                  {/each}
                </select>
                <button class="btn btn-sm btn-warning" onclick={assignLot}>{m['common.assign']()}</button>
              </div>
            {/if}

            <!-- Confirm form -->
            {#if selected.lot_id || selected.lot_number}
              <form onsubmit={confirm} class="space-y-2">
                <div>
                  <label class="label-text text-sm font-medium">
                    Cantitate efectiv expediată
                    <span class="opacity-50">(max {selected.lot_qty_remaining} {selected.unit})</span>
                  </label>
                  <input
                    type="number"
                    class="input input-bordered w-full"
                    min="0.001"
                    max={selected.lot_qty_remaining}
                    step="0.001"
                    bind:value={confirmForm.quantity_dispatched}
                    required
                  />
                </div>
                <div>
                  <label class="label-text text-sm">{m['operations.traceability.form.notes']()}</label>
                  <textarea class="textarea textarea-bordered w-full" rows="2" bind:value={confirmForm.notes}></textarea>
                </div>
                <div class="flex gap-2">
                  <button type="submit" class="btn btn-success flex-1" disabled={confirming}>
                    {confirming ? 'Se procesează...' : '✓ Confirmă expedierea'}
                  </button>
                  <button type="button" class="btn btn-ghost btn-sm" onclick={() => cancelDispatch(selected.id)}>
                    Anulează
                  </button>
                </div>
              </form>
            {/if}
          {:else}
            <!-- Confirmed view -->
            <div class="text-sm space-y-1">
              <div class="flex justify-between">
                <span class="opacity-60">{m['operations.traceability.dispatches.dispatchedQty']()}</span>
                <span class="font-bold text-success">{selected.quantity_dispatched} {selected.unit}</span>
              </div>
              <div class="flex justify-between">
                <span class="opacity-60">{m['operations.traceability.dispatches.confirmedAt']()}</span>
                <span>{selected.confirmed_at ? new Date(selected.confirmed_at).toLocaleString('ro-RO') : '—'}</span>
              </div>
            </div>
          {/if}

          <button class="btn btn-ghost btn-sm w-full" onclick={() => (selected = null)}>{m['common.close']()}</button>
        </div>
      {/if}
    </div>
  {/if}
  </div>

<ConfirmModal
  open={confirmState.open}
  title={confirmState.title}
  message={confirmState.message}
  confirmLabel={confirmState.confirmLabel}
  confirmClass={confirmState.confirmClass}
  onconfirm={runConfirmAction}
  oncancel={cancelConfirm}
/>

</ExtensionPageShell>
