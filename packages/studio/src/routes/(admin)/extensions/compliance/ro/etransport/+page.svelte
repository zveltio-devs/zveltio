<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { Plus, Trash2, Truck, CheckCircle, XCircle, RefreshCw, Send, LoaderCircle } from '@lucide/svelte';

  let declarations = $state<any[]>([]);
  let loading = $state(true);
  let filter = $state('all');
  let showModal = $state(false);
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

  onMount(loadDeclarations);
  $effect(() => { filter; loadDeclarations(); });

  async function loadDeclarations() {
    loading = true;
    try {
      const qs = filter !== 'all' ? `?status=${filter}` : '';
      const r = await api.get<{ declarations: any[] }>(`/api/etransport${qs}`);
      declarations = r.declarations ?? [];
    } catch (e: any) { toast.error(e?.message ?? 'Failed to load'); }
    finally { loading = false; }
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
      await api.post('/api/etransport', form);
      showModal = false;
      await loadDeclarations();
      toast.success('Declaratie creata.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { submitting = false; }
  }

  async function declare(id: string) {
    if (!confirm('Trimite declaratia la ANAF e-Transport?')) return;
    try {
      const data = await api.post<any>(`/api/etransport/${id}/declare`, {});
      toast.success(`Declarat! UIT: ${data.uit}`);
      await loadDeclarations();
    } catch (e: any) { toast.error(e?.message ?? 'Failed'); }
  }

  async function complete(id: string) {
    try { await api.post(`/api/etransport/${id}/complete`, {}); await loadDeclarations(); }
    catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }

  async function cancel(id: string) {
    if (!confirm('Anuleaza declaratia?')) return;
    try { await api.post(`/api/etransport/${id}/cancel`, {}); await loadDeclarations(); }
    catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }

  async function deleteDecl(id: string) {
    if (!confirm('Sterge declaratia?')) return;
    try { await api.delete(`/api/etransport/${id}`); await loadDeclarations(); }
    catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }

  function statusBadge(status: string): string {
    return ({ draft: 'badge-warning', declared: 'badge-primary', in_transit: 'badge-info', completed: 'badge-success', cancelled: 'badge-error' } as Record<string, string>)[status] ?? 'badge-ghost';
  }

  const STATUSES = ['all', 'draft', 'declared', 'in_transit', 'completed', 'cancelled'];
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold flex items-center gap-2"><Truck size={20} /> e-Transport RO</h1>
      <p class="text-sm text-base-content/50">Declare and track road transport of goods via ANAF</p>
    </div>
    <div class="flex gap-2">
      <button class="btn btn-ghost btn-sm" onclick={loadDeclarations}><RefreshCw size={14} /></button>
      <button class="btn btn-primary btn-sm gap-1" onclick={openCreate}><Plus size={14} /> New Declaration</button>
    </div>
  </div>

  <div class="tabs tabs-boxed bg-base-200 w-fit">
    {#each STATUSES as s}
      <button class="tab {filter === s ? 'tab-active' : ''}" onclick={() => (filter = s)}>
        {s === 'all' ? 'All' : s.replace('_', ' ')}
      </button>
    {/each}
  </div>

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if declarations.length === 0}
    <div class="card bg-base-200">
      <div class="card-body items-center py-12 text-base-content/50 text-sm">
        <Truck size={40} class="opacity-20 mb-2" /> No transport declarations
      </div>
    </div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>UIT</th><th>Date</th><th>Vehicle</th><th>Driver</th><th>Route</th><th>Weight (kg)</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {#each declarations as decl (decl.id)}
            <tr class="hover">
              <td class="font-mono text-xs text-base-content/50">{decl.uit || '—'}</td>
              <td class="text-sm">{decl.transport_date}</td>
              <td class="font-mono font-medium text-sm">{decl.vehicle_plate}</td>
              <td class="text-sm">{decl.driver_name}</td>
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
  {/if}
</div>

{#if showModal}
  <dialog class="modal modal-open">
    <div class="modal-box w-11/12 max-w-3xl">
      <h3 class="font-bold text-lg mb-4">New Transport Declaration</h3>

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
          <label class="label" for="transport-vehicle"><span class="label-text text-xs">Vehicle plate</span></label>
          <input id="transport-vehicle" type="text" bind:value={form.vehicle_plate} placeholder="B 123 ABC" class="input input-sm font-mono uppercase" />
        </div>
        <div class="form-control">
          <label class="label" for="transport-driver"><span class="label-text text-xs">Driver name</span></label>
          <input id="transport-driver" type="text" bind:value={form.driver_name} placeholder="Ion Popescu" class="input input-sm" />
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
        <button class="btn btn-primary" onclick={saveDeclaration} disabled={submitting || !form.vehicle_plate || !form.driver_name}>
          {#if submitting}<span class="loading loading-spinner loading-sm"></span>{/if} Create Declaration
        </button>
      </div>
    </div>
    <button class="modal-backdrop" onclick={() => (showModal = false)}></button>
  </dialog>
{/if}
