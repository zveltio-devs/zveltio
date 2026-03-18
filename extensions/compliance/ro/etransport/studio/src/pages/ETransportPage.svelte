<script lang="ts">
  import { onMount } from 'svelte';
  import { Plus, Trash2, Truck, CheckCircle, XCircle, RefreshCw, Send } from '@lucide/svelte';

  const engineUrl = (window as any).__ZVELTIO_ENGINE_URL__ || '';

  let declarations = $state<any[]>([]);
  let loading = $state(true);
  let filter = $state('all');
  let showModal = $state(false);
  let editId = $state<string | null>(null);
  let submitting = $state(false);

  let form = $state({
    transport_date: new Date().toISOString().split('T')[0],
    vehicle_plate: '',
    driver_name: '',
    driver_cnp: '',
    departure_address: '',
    departure_county: '',
    departure_country: 'RO',
    destination_address: '',
    destination_county: '',
    destination_country: 'RO',
    goods: [{ tariff_code: '', description: '', quantity: 1, unit: 'BUC', weight_kg: 0 }],
    total_weight_kg: 0,
    purpose: 'commercial',
  });

  onMount(() => loadDeclarations());
  $effect(() => { if (filter) loadDeclarations(); });

  async function loadDeclarations() {
    loading = true;
    try {
      const qs = filter !== 'all' ? `?status=${filter}` : '';
      const res = await fetch(`${engineUrl}/api/etransport${qs}`, { credentials: 'include' });
      const data = await res.json();
      declarations = data.declarations || [];
    } finally {
      loading = false;
    }
  }

  function recalcWeight() {
    form.total_weight_kg = form.goods.reduce((s, g) => s + Number(g.weight_kg || 0), 0);
  }

  function addGood() {
    form.goods = [...form.goods, { tariff_code: '', description: '', quantity: 1, unit: 'BUC', weight_kg: 0 }];
  }

  function removeGood(i: number) {
    form.goods = form.goods.filter((_, idx) => idx !== i);
    recalcWeight();
  }

  function openCreate() {
    editId = null;
    form = {
      transport_date: new Date().toISOString().split('T')[0],
      vehicle_plate: '', driver_name: '', driver_cnp: '',
      departure_address: '', departure_county: '', departure_country: 'RO',
      destination_address: '', destination_county: '', destination_country: 'RO',
      goods: [{ tariff_code: '', description: '', quantity: 1, unit: 'BUC', weight_kg: 0 }],
      total_weight_kg: 0, purpose: 'commercial',
    };
    showModal = true;
  }

  async function saveDeclaration() {
    if (!form.vehicle_plate || !form.driver_name) return;
    recalcWeight();
    submitting = true;
    try {
      const url = editId ? `${engineUrl}/api/etransport/${editId}` : `${engineUrl}/api/etransport`;
      const method = editId ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error('Failed');
      showModal = false;
      await loadDeclarations();
    } finally {
      submitting = false;
    }
  }

  async function declare(id: string) {
    if (!confirm('Submit this declaration to ANAF e-Transport?')) return;
    const res = await fetch(`${engineUrl}/api/etransport/${id}/declare`, {
      method: 'POST', credentials: 'include',
    });
    const data = await res.json();
    if (res.ok) {
      alert(`Declared! UIT: ${data.uit}`);
      await loadDeclarations();
    } else {
      alert(data.error || 'Failed');
    }
  }

  async function complete(id: string) {
    await fetch(`${engineUrl}/api/etransport/${id}/complete`, { method: 'POST', credentials: 'include' });
    await loadDeclarations();
  }

  async function cancel(id: string) {
    if (!confirm('Cancel this declaration?')) return;
    await fetch(`${engineUrl}/api/etransport/${id}/cancel`, { method: 'POST', credentials: 'include' });
    await loadDeclarations();
  }

  async function deleteDecl(id: string) {
    if (!confirm('Delete this declaration?')) return;
    await fetch(`${engineUrl}/api/etransport/${id}`, { method: 'DELETE', credentials: 'include' });
    await loadDeclarations();
  }

  function statusBadge(status: string): string {
    return {
      draft: 'badge-warning',
      declared: 'badge-primary',
      in_transit: 'badge-info',
      completed: 'badge-success',
      cancelled: 'badge-error',
    }[status] || 'badge-ghost';
  }

  const STATUSES = ['all', 'draft', 'declared', 'in_transit', 'completed', 'cancelled'];
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">e-Transport RO</h1>
      <p class="text-base-content/60 text-sm mt-1">Declare and track road transport of goods via ANAF</p>
    </div>
    <div class="flex gap-2">
      <button class="btn btn-ghost btn-sm" onclick={loadDeclarations}><RefreshCw size={14} /></button>
      <button class="btn btn-primary btn-sm gap-2" onclick={openCreate}>
        <Plus size={16} /> New Declaration
      </button>
    </div>
  </div>

  <div class="tabs tabs-boxed w-fit">
    {#each STATUSES as s}
      <button class="tab {filter === s ? 'tab-active' : ''}" onclick={() => (filter = s)}>
        {s === 'all' ? 'All' : s.replace('_', ' ')}
      </button>
    {/each}
  </div>

  {#if loading}
    <div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg"></span></div>
  {:else if declarations.length === 0}
    <div class="card bg-base-200 text-center py-12">
      <Truck size={48} class="mx-auto text-base-content/20 mb-3" />
      <p class="text-base-content/60">No transport declarations</p>
      <button class="btn btn-primary btn-sm mt-4" onclick={openCreate}>Create Declaration</button>
    </div>
  {:else}
    <div class="card bg-base-200">
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead>
            <tr>
              <th>UIT</th>
              <th>Date</th>
              <th>Vehicle</th>
              <th>Driver</th>
              <th>Route</th>
              <th>Weight (kg)</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each declarations as decl}
              <tr>
                <td class="font-mono text-xs text-base-content/50">{decl.uit || '—'}</td>
                <td>{decl.transport_date}</td>
                <td class="font-mono font-medium">{decl.vehicle_plate}</td>
                <td>{decl.driver_name}</td>
                <td class="text-xs">{decl.departure_county} → {decl.destination_county}</td>
                <td class="font-mono text-xs">{Number(decl.total_weight_kg).toFixed(0)}</td>
                <td><span class="badge badge-sm {statusBadge(decl.status)}">{decl.status.replace('_', ' ')}</span></td>
                <td>
                  <div class="flex gap-1">
                    {#if decl.status === 'draft'}
                      <button class="btn btn-ghost btn-xs text-primary" onclick={() => declare(decl.id)} title="Declare to ANAF">
                        <Send size={12} />
                      </button>
                      <button class="btn btn-ghost btn-xs text-error" onclick={() => deleteDecl(decl.id)}>
                        <Trash2 size={12} />
                      </button>
                    {/if}
                    {#if decl.status === 'declared' || decl.status === 'in_transit'}
                      <button class="btn btn-ghost btn-xs text-success" onclick={() => complete(decl.id)} title="Mark completed">
                        <CheckCircle size={12} />
                      </button>
                      <button class="btn btn-ghost btn-xs text-error" onclick={() => cancel(decl.id)} title="Cancel">
                        <XCircle size={12} />
                      </button>
                    {/if}
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
</div>

{#if showModal}
  <dialog class="modal modal-open">
    <div class="modal-box w-11/12 max-w-3xl">
      <h3 class="font-bold text-lg mb-4">{editId ? 'Edit' : 'New'} Transport Declaration</h3>

      <div class="grid grid-cols-2 gap-4 mb-4">
        <div class="form-control">
          <label class="label" for="transport-date"><span class="label-text text-xs">Transport date</span></label>
          <input id="transport-date" type="date" bind:value={form.transport_date} class="input input-sm" />
        </div>
        <div class="form-control">
          <label class="label" for="transport-purpose"><span class="label-text text-xs">Purpose</span></label>
          <select id="transport-purpose" bind:value={form.purpose} class="select select-sm">
            <option value="commercial">Commercial</option>
            <option value="personal">Personal</option>
            <option value="return">Return</option>
          </select>
        </div>
        <div class="form-control">
          <label class="label" for="transport-vehicle-plate"><span class="label-text text-xs">Vehicle plate</span></label>
          <input id="transport-vehicle-plate" type="text" bind:value={form.vehicle_plate} placeholder="B 123 ABC" class="input input-sm font-mono uppercase" />
        </div>
        <div class="form-control">
          <label class="label" for="transport-driver-name"><span class="label-text text-xs">Driver name</span></label>
          <input id="transport-driver-name" type="text" bind:value={form.driver_name} placeholder="Ion Popescu" class="input input-sm" />
        </div>
      </div>

      <div class="grid grid-cols-2 gap-4 mb-4">
        <div class="card bg-base-200 p-3">
          <p class="font-semibold text-sm mb-2">Departure</p>
          <div class="space-y-2">
            <input type="text" bind:value={form.departure_address} placeholder="Address" class="input input-sm w-full" />
            <div class="grid grid-cols-2 gap-2">
              <input type="text" bind:value={form.departure_county} placeholder="County" class="input input-sm" />
              <input type="text" bind:value={form.departure_country} placeholder="Country" class="input input-sm font-mono" />
            </div>
          </div>
        </div>
        <div class="card bg-base-200 p-3">
          <p class="font-semibold text-sm mb-2">Destination</p>
          <div class="space-y-2">
            <input type="text" bind:value={form.destination_address} placeholder="Address" class="input input-sm w-full" />
            <div class="grid grid-cols-2 gap-2">
              <input type="text" bind:value={form.destination_county} placeholder="County" class="input input-sm" />
              <input type="text" bind:value={form.destination_country} placeholder="Country" class="input input-sm font-mono" />
            </div>
          </div>
        </div>
      </div>

      <div class="mb-4">
        <div class="flex items-center justify-between mb-2">
          <p class="font-semibold text-sm">Goods</p>
          <button class="btn btn-ghost btn-xs" onclick={addGood}>+ Add good</button>
        </div>
        <div class="overflow-x-auto">
          <table class="table table-xs">
            <thead><tr><th>Tariff code</th><th>Description</th><th>Qty</th><th>Unit</th><th>Weight (kg)</th><th></th></tr></thead>
            <tbody>
              {#each form.goods as good, i}
                <tr>
                  <td><input type="text" bind:value={good.tariff_code} class="input input-xs w-24 font-mono" /></td>
                  <td><input type="text" bind:value={good.description} class="input input-xs w-40" /></td>
                  <td><input type="number" bind:value={good.quantity} class="input input-xs w-16" /></td>
                  <td><input type="text" bind:value={good.unit} class="input input-xs w-16" /></td>
                  <td><input type="number" step="0.01" bind:value={good.weight_kg} oninput={recalcWeight} class="input input-xs w-20" /></td>
                  <td>
                    {#if form.goods.length > 1}
                      <button onclick={() => removeGood(i)} class="btn btn-ghost btn-xs text-error">✕</button>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="text-right text-sm mt-2">Total weight: <strong class="font-mono">{form.total_weight_kg.toFixed(2)} kg</strong></p>
      </div>

      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => (showModal = false)}>Cancel</button>
        <button class="btn btn-primary" onclick={saveDeclaration} disabled={submitting}>
          {#if submitting}<span class="loading loading-spinner loading-sm"></span>{/if}
          {editId ? 'Save Changes' : 'Create Declaration'}
        </button>
      </div>
    </div>
    <button class="modal-backdrop" onclick={() => (showModal = false)}></button>
  </dialog>
{/if}
