<script lang="ts">
  import { m } from '$lib/i18n.svelte.js';
  import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
  import { createExtensionConfirm } from '$lib/utils/extension-confirm.svelte.js';
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
        import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { Plus, Trash2, Truck, CheckCircle, XCircle, RefreshCw, Send, LoaderCircle } from '@lucide/svelte';

  const { confirmState, askConfirm, runConfirmAction, cancelConfirm } = createExtensionConfirm();

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
      const r = await api.get<{ declarations: any[] }>(`/ext/compliance/ro/etransport${qs}`);
      declarations = r.declarations ?? [];
    } catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.loadFailed']()); }
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
      await api.post('/ext/compliance/ro/etransport', form);
      showModal = false;
      await loadDeclarations();
      toast.success(m['compliance.ro.etransport.toast.created']());
    } catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.saveFailed']()); }
    finally { submitting = false; }
  }

  async function declare(id: string) {
        askConfirm(m['compliance.ro.etransport.confirmSend'](), () => declareConfirmed(id));
  }
  async function declareConfirmed(id: string) {
    try {
      const data = await api.post<any>(`/ext/compliance/ro/etransport/${id}/declare`, {});
      toast.success(m['ext.saved']());
      await loadDeclarations();
    } catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.loadFailed']()); }
  }


  async function complete(id: string) {
    try { await api.post(`/ext/compliance/ro/etransport/${id}/complete`, {}); await loadDeclarations(); }
    catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.saveFailed']()); }
  }

  async function cancel(id: string) {
        askConfirm(m['compliance.ro.etransport.confirmCancel'](), () => cancelConfirmed(id));
  }
  async function cancelConfirmed(id: string) {
    try { await api.post(`/ext/compliance/ro/etransport/${id}/cancel`, {}); await loadDeclarations(); }
    catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.saveFailed']()); }
  }


  async function deleteDecl(id: string) {
        askConfirm(m['compliance.ro.etransport.confirmDelete'](), () => deleteDeclConfirmed(id));
  }
  async function deleteDeclConfirmed(id: string) {
    try { await api.delete(`/ext/compliance/ro/etransport/${id}`); await loadDeclarations(); }
    catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.saveFailed']()); }
  }


function transportStatusLabel(s: string): string {
    const map: Record<string, () => string> = {
      all: () => m['common.filter.all'](),
      draft: () => m['compliance.ro.etransport.status.draft'](),
      declared: () => m['compliance.ro.etransport.status.declared'](),
      in_transit: () => m['compliance.ro.etransport.status.inTransit'](),
      completed: () => m['compliance.ro.etransport.status.completed'](),
      cancelled: () => m['compliance.ro.etransport.status.cancelled'](),
    };
    return (map[s] ?? (() => s))();
  }

  function statusBadge(status: string): string {
    return ({ draft: 'badge-warning', declared: 'badge-primary', in_transit: 'badge-info', completed: 'badge-success', cancelled: 'badge-error' } as Record<string, string>)[status] ?? 'badge-ghost';
  }

  const STATUSES = ['all', 'draft', 'declared', 'in_transit', 'completed', 'cancelled'];
</script>

<ExtensionPageShell title={m['compliance.ro.etransport.title']()} subtitle={m['compliance.ro.etransport.subtitle']()}>
  {#snippet actions()}
    <button type="button" class="btn btn-primary btn-sm gap-1" onclick={openCreate}><Plus size={14} /> {m['compliance.ro.etransport.btn.newDeclaration']()}</button>
  {/snippet}

  {#snippet children()}
<div class="tabs tabs-boxed bg-base-200 w-fit">
    {#each STATUSES as s}
      <button class="tab {filter === s ? 'tab-active' : ''}" onclick={() => (filter = s)}>
        {transportStatusLabel(s)}
      </button>
    {/each}
</div>

{#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if declarations.length === 0}
    <div class="card bg-base-200">
      <div class="card-body items-center py-12 text-base-content/50 text-sm">
        <Truck size={40} class="opacity-20 mb-2" /> {m['compliance.ro.etransport.empty.declarations']()}
      </div>
    </div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>{m['compliance.ro.etransport.col.uit']()}</th><th>{m['common.col.date']()}</th><th>{m['compliance.ro.etransport.col.vehicle']()}</th><th>{m['compliance.ro.etransport.col.driver']()}</th><th>{m['compliance.ro.etransport.col.route']()}</th><th>{m['compliance.ro.etransport.col.weightKg']()}</th><th>{m['common.col.status']()}</th><th></th></tr></thead>
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
                    <button class="btn btn-ghost btn-xs text-primary" onclick={() => declare(decl.id)} title={m['compliance.ro.etransport.action.declare']()}>
                      <Send size={12} />
                    </button>
                    <button class="btn btn-ghost btn-xs text-error" onclick={() => deleteDecl(decl.id)}>
                      <Trash2 size={12} />
                    </button>
                  {/if}
                  {#if decl.status === 'declared' || decl.status === 'in_transit'}
                    <button class="btn btn-ghost btn-xs text-success" onclick={() => complete(decl.id)} title={m['compliance.ro.etransport.action.complete']()}>
                      <CheckCircle size={12} />
                    </button>
                    <button class="btn btn-ghost btn-xs text-error" onclick={() => cancel(decl.id)} title={m['compliance.ro.etransport.action.cancel']()}>
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
  {/snippet}

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

{#if showModal}
  <dialog class="modal modal-open">
    <div class="modal-box w-11/12 max-w-3xl">
      <h3 class="font-bold text-lg mb-4">{m['compliance.ro.etransport.ui.new_transport_declaration']()}</h3>

      <div class="grid grid-cols-2 gap-4 mb-4">
        <div class="form-control">
          <label class="label" for="transport-date"><span class="label-text text-xs">{m['compliance.ro.etransport.ui.transport_date']()}</span></label>
          <input id="transport-date" type="date" bind:value={form.transport_date} class="input input-sm" />
        </div>
        <div class="form-control">
          <label class="label" for="transport-purpose"><span class="label-text text-xs">{m['compliance.ro.etransport.ui.purpose']()}</span></label>
          <select id="transport-purpose" bind:value={form.purpose} class="select select-sm">
            <option value="commercial">{m['compliance.ro.etransport.ui.commercial']()}</option>
            <option value="personal">{m['compliance.ro.etransport.ui.personal']()}</option>
            <option value="return">{m['compliance.ro.etransport.ui.return']()}</option>
          </select>
        </div>
        <div class="form-control">
          <label class="label" for="transport-vehicle"><span class="label-text text-xs">{m['compliance.ro.etransport.ui.vehicle_plate']()}</span></label>
          <input id="transport-vehicle" type="text" bind:value={form.vehicle_plate} placeholder={m['compliance.ro.etransport.ui.b_123_abc']()} class="input input-sm font-mono uppercase" />
        </div>
        <div class="form-control">
          <label class="label" for="transport-driver"><span class="label-text text-xs">{m['compliance.ro.etransport.ui.driver_name']()}</span></label>
          <input id="transport-driver" type="text" bind:value={form.driver_name} placeholder={m['compliance.ro.etransport.ui.ion_popescu']()} class="input input-sm" />
        </div>
      </div>

      <div class="grid grid-cols-2 gap-4 mb-4">
        <div class="card bg-base-200 p-3">
          <p class="font-semibold text-sm mb-2">{m['compliance.ro.etransport.section.departure']()}</p>
          <div class="space-y-2">
            <input type="text" bind:value={form.departure_address} placeholder={m['hr.employees.form.address']()} class="input input-sm w-full" />
            <div class="grid grid-cols-2 gap-2">
              <input type="text" bind:value={form.departure_county} placeholder={m['compliance.ro.etransport.ui.county']()} class="input input-sm" />
              <input type="text" bind:value={form.departure_country} placeholder={m['compliance.ro.etransport.ui.country']()} class="input input-sm font-mono" />
            </div>
          </div>
        </div>
        <div class="card bg-base-200 p-3">
          <p class="font-semibold text-sm mb-2">{m['compliance.ro.etransport.section.destination']()}</p>
          <div class="space-y-2">
            <input type="text" bind:value={form.destination_address} placeholder={m['hr.employees.form.address']()} class="input input-sm w-full" />
            <div class="grid grid-cols-2 gap-2">
              <input type="text" bind:value={form.destination_county} placeholder={m['compliance.ro.etransport.ui.county']()} class="input input-sm" />
              <input type="text" bind:value={form.destination_country} placeholder={m['compliance.ro.etransport.ui.country']()} class="input input-sm font-mono" />
            </div>
          </div>
        </div>
      </div>

      <div class="mb-4">
        <div class="flex items-center justify-between mb-2">
          <p class="font-semibold text-sm">{m['compliance.ro.etransport.section.goods']()}</p>
          <button class="btn btn-ghost btn-xs" onclick={addGood}>{m['compliance.ro.etransport.ui.add_good']()}</button>
        </div>
        <div class="overflow-x-auto">
          <table class="table table-xs">
            <thead><tr><th>{m['compliance.ro.etransport.col.tariffCode']()}</th><th>{m['common.col.description']()}</th><th>{m['compliance.ro.efactura.col.qty']()}</th><th>{m['compliance.ro.efactura.col.unit']()}</th><th>{m['compliance.ro.etransport.col.weightKg']()}</th><th></th></tr></thead>
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
        <p class="text-right text-sm mt-2">{m['compliance.ro.etransport.totals.weight']()}: <strong class="font-mono">{form.total_weight_kg.toFixed(2)} kg</strong></p>
      </div>

      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => (showModal = false)}>{m['common.cancel']()}</button>
        <button class="btn btn-primary" onclick={saveDeclaration} disabled={submitting || !form.vehicle_plate || !form.driver_name}>
          {#if submitting}<span class="loading loading-spinner loading-sm"></span>{/if} {m['compliance.ro.etransport.btn.createDeclaration']()}
        </button>
      </div>
    </div>
    <button class="modal-backdrop" onclick={() => (showModal = false)}></button>
  </dialog>
{/if}
