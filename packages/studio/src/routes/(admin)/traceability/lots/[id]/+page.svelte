<script lang="ts">
  import { m } from '$lib/i18n.svelte.js';
  import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
  import { createExtensionConfirm } from '$lib/utils/extension-confirm.svelte.js';
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import { api } from '$lib/api.js';
  const { confirmState, askConfirm, runConfirmAction, cancelConfirm } = createExtensionConfirm();

  const API = '/ext/operations/traceability';

  let { id }: { id: string } = $props();

  let lot = $state<any>(null);
  let timeline = $state<any[]>([]);
  let upstream = $state<any>(null);
  let loading = $state(true);
  let error = $state('');
  let activeTab = $state<'info' | 'tree' | 'timeline'>('info');
  let releasing = $state(false);

  $effect(() => {
    loadLot();
  });

  async function loadLot() {
    loading = true;
    error = '';
    try {
      const [lotRes, timelineRes] = await Promise.all([
        api.fetch(`${API}/lots/${id}`),
        api.fetch(`${API}/tree/${id}/timeline`),
      ]);
      if (!lotRes.ok) throw new Error(await lotRes.text());
      lot = (await lotRes.json()).data;
      timeline = timelineRes.ok ? (await timelineRes.json()).data : [];
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  async function loadUpstream() {
    if (upstream) return;
    try {
      const res = await api.fetch(`${API}/tree/${id}/upstream`);
      upstream = res.ok ? (await res.json()).data : null;
    } catch {}
  }

  async function releaseLot() {
        askConfirm(m['operations.traceability.confirmReleaseLot'](), () => releaseLotConfirmed());
  }
  async function releaseLotConfirmed() {
    releasing = true;
    try {
      const res = await api.fetch(`${API}/lots/${id}/release`, { method: 'PATCH' });
      if (!res.ok) throw new Error(await res.text());
      await loadLot();
    } catch (e: any) {
      alert(e.message);
    } finally {
      releasing = false;
    }
  }


  async function printLabel() {
    window.open(`${API}/labels/${id}`, '_blank');
  }

  function statusClass(status: string): string {
    return { available: 'badge-success', quarantine: 'badge-warning', exhausted: 'badge-neutral', recalled: 'badge-error', returned: 'badge-info' }[status] ?? 'badge-ghost';
  }

  function renderTree(node: any, depth = 0): string {
    if (!node) return '';
    const indent = '  '.repeat(depth);
    const status = node.status ? ` [${node.status}]` : '';
    const line = `${indent}${node.item_name ?? '?'} — ${node.lot_number ?? node.lot_id}${status}`;
    const children = (node.inputs ?? []).map((c: any) => renderTree(c, depth + 1)).join('\n');
    return children ? `${line}\n${children}` : line;
  }
</script>

<ExtensionPageShell title={lot?.lot_number ?? m['operations.traceability.lots.title']()}>
  {#snippet headerExtras()}
    {#if lot}<span class="badge {statusClass(lot.status)}">{lot.status}</span>{/if}
  {/snippet}
  {#snippet children()}
  <div class="p-6 space-y-4 pt-0">
  <div class="flex items-center gap-3 mb-2">
    <a href="/admin/trace/lots" class="btn btn-ghost btn-sm">{m['workflow.checklists.btn.back']()}</a>
  </div>

  {#if error}
    <div class="alert alert-error">{error}</div>
  {/if}

  {#if loading}
    <div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg"></span></div>
  {:else if lot}
    <div class="flex gap-2">
      {#if lot.status === 'quarantine'}
        <button class="btn btn-success btn-sm" onclick={releaseLot} disabled={releasing}>
          {releasing ? 'Se procesează...' : '✓ Eliberează din carantină'}
        </button>
      {/if}
      <button class="btn btn-outline btn-sm" onclick={printLabel}>{m['operations.traceability.ui.printeaz_etichet']()}</button>
    </div>

    <div class="tabs tabs-bordered">
      <button class="tab {activeTab === 'info' ? 'tab-active' : ''}" onclick={() => activeTab = 'info'}>{m['operations.traceability.lot.tab.info']()}</button>
      <button class="tab {activeTab === 'tree' ? 'tab-active' : ''}" onclick={() => { activeTab = 'tree'; loadUpstream(); }}>{m['operations.traceability.lot.tab.tree']()}</button>
      <button class="tab {activeTab === 'timeline' ? 'tab-active' : ''}" onclick={() => activeTab = 'timeline'}>{m['operations.traceability.lot.tab.timeline']()}</button>
    </div>

    {#if activeTab === 'info'}
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="card bg-base-200 p-4 space-y-2">
          <h3 class="font-bold">{m['operations.traceability.ui.produs']()}</h3>
          <div><span class="text-sm opacity-60">{m['operations.traceability.lot.label.name']()}</span> <span class="font-medium">{lot.item_name}</span></div>
          <div><span class="text-sm opacity-60">{m['operations.traceability.lot.label.code']()}</span> <span class="font-mono">{lot.item_code}</span></div>
          <div><span class="text-sm opacity-60">{m['operations.traceability.lot.label.type']()}</span> {lot.item_type}</div>
          {#if lot.allergens?.length}
            <div><span class="text-sm opacity-60">{m['operations.traceability.lot.label.allergens']()}</span> {lot.allergens.join(', ')}</div>
          {/if}
          {#if lot.storage_conditions}
            <div><span class="text-sm opacity-60">{m['operations.traceability.lot.label.conditions']()}</span> {lot.storage_conditions}</div>
          {/if}
        </div>

        <div class="card bg-base-200 p-4 space-y-2">
          <h3 class="font-bold">{m['operations.traceability.ui.cantitate_valabilitate']()}</h3>
          <div><span class="text-sm opacity-60">{m['operations.traceability.lot.label.initial']()}</span> {lot.quantity_initial} {lot.unit}</div>
          <div><span class="text-sm opacity-60">{m['operations.traceability.lot.label.remaining']()}</span> <span class="font-bold">{lot.quantity_remaining} {lot.unit}</span></div>
          {#if lot.best_before_date}
            <div><span class="text-sm opacity-60">{m['operations.traceability.lot.label.bbd']()}</span> <span class="font-bold">{lot.best_before_date}</span></div>
          {/if}
          {#if lot.production_date}
            <div><span class="text-sm opacity-60">{m['operations.traceability.lot.label.productionDate']()}</span> {lot.production_date}</div>
          {/if}
          <div><span class="text-sm opacity-60">{m['operations.traceability.lot.label.receptionDate']()}</span> {lot.reception_date ?? lot.created_at?.slice(0, 10)}</div>
        </div>

        <div class="card bg-base-200 p-4 space-y-2">
          <h3 class="font-bold">{m['compliance.ro.procurement.ui.furnizor']()}</h3>
          <div>{lot.supplier_name ?? 'N/A'}</div>
          {#if lot.supplier_cui}
            <div><span class="text-sm opacity-60">{m['operations.traceability.lot.label.cui']()}</span> {lot.supplier_cui}</div>
          {/if}
          {#if lot.supplier_lot_ref}
            <div><span class="text-sm opacity-60">{m['operations.traceability.lot.label.supplierLot']()}</span> <span class="font-mono">{lot.supplier_lot_ref}</span></div>
          {/if}
          {#if lot.invoice_ref}
            <div><span class="text-sm opacity-60">{m['operations.traceability.lot.label.invoice']()}</span> {lot.invoice_ref}</div>
          {/if}
        </div>

        <div class="card bg-base-200 p-4 space-y-2">
          <h3 class="font-bold">{m['operations.traceability.ui.loca_ie']()}</h3>
          <div>{lot.warehouse ?? 'Nespecificat'}</div>
          {#if lot.row}<div><span class="text-sm opacity-60">{m['operations.traceability.lot.label.row']()}</span> {lot.row}</div>{/if}
          {#if lot.shelf}<div><span class="text-sm opacity-60">{m['operations.traceability.lot.label.shelf']()}</span> {lot.shelf}</div>{/if}
          {#if lot.temperature_zone}<div><span class="text-sm opacity-60">{m['operations.traceability.lot.label.zone']()}</span> {lot.temperature_zone}</div>{/if}
        </div>
      </div>
    {/if}

    {#if activeTab === 'tree'}
      {#if !upstream}
        <div class="flex justify-center py-8"><span class="loading loading-spinner"></span></div>
      {:else}
        <div class="card bg-base-200 p-4">
          <h3 class="font-bold mb-3">{m['operations.traceability.ui.materii_prime_upstream']()}</h3>
          <pre class="text-sm font-mono whitespace-pre-wrap">{renderTree(upstream)}</pre>
        </div>
      {/if}
    {/if}

    {#if activeTab === 'timeline'}
      <div class="overflow-x-auto">
        <table class="table table-sm w-full">
          <thead>
            <tr><th>{m['operations.traceability.lot.col.datetime']()}</th><th>{m['operations.traceability.lot.col.type']()}</th><th>{m['operations.traceability.lot.col.quantity']()}</th><th>{m['operations.traceability.lot.col.reference']()}</th><th>{m['operations.traceability.col.location']()}</th></tr>
          </thead>
          <tbody>
            {#each timeline as event}
              <tr>
                <td class="text-xs">{new Date(event.performed_at).toLocaleString('ro-RO')}</td>
                <td><span class="badge badge-sm badge-outline">{event.type}</span></td>
                <td class="font-mono">{event.quantity > 0 ? '+' : ''}{event.quantity} {event.unit}</td>
                <td class="text-sm">{event.reference_number ?? '—'}</td>
                <td class="text-xs">{[event.from_warehouse, event.to_warehouse].filter(Boolean).join(' → ') || '—'}</td>
              </tr>
            {/each}
            {#if timeline.length === 0}
              <tr><td colspan="5" class="text-center opacity-50 py-4">{m['operations.traceability.ui.nicio_mi_care_nregistrat']()}</td></tr>
            {/if}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
  </div>
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
