<script lang="ts">
  import { api } from '$lib/api.js';
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
    if (!confirm('Eliberați lotul din carantină?')) return;
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

<div class="p-6 space-y-4">
  <div class="flex items-center gap-3">
    <a href="/admin/trace/lots" class="btn btn-ghost btn-sm">← Înapoi</a>
    {#if lot}
      <h1 class="text-2xl font-bold font-mono">{lot.lot_number}</h1>
      <span class="badge {statusClass(lot.status)}">{lot.status}</span>
    {/if}
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
      <button class="btn btn-outline btn-sm" onclick={printLabel}>🖨 Printează etichetă</button>
    </div>

    <div class="tabs tabs-bordered">
      <button class="tab {activeTab === 'info' ? 'tab-active' : ''}" onclick={() => activeTab = 'info'}>Informații</button>
      <button class="tab {activeTab === 'tree' ? 'tab-active' : ''}" onclick={() => { activeTab = 'tree'; loadUpstream(); }}>Arbore trasabilitate</button>
      <button class="tab {activeTab === 'timeline' ? 'tab-active' : ''}" onclick={() => activeTab = 'timeline'}>Cronologie</button>
    </div>

    {#if activeTab === 'info'}
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="card bg-base-200 p-4 space-y-2">
          <h3 class="font-bold">Produs</h3>
          <div><span class="text-sm opacity-60">Denumire:</span> <span class="font-medium">{lot.item_name}</span></div>
          <div><span class="text-sm opacity-60">Cod:</span> <span class="font-mono">{lot.item_code}</span></div>
          <div><span class="text-sm opacity-60">Tip:</span> {lot.item_type}</div>
          {#if lot.allergens?.length}
            <div><span class="text-sm opacity-60">Alergeni:</span> {lot.allergens.join(', ')}</div>
          {/if}
          {#if lot.storage_conditions}
            <div><span class="text-sm opacity-60">Condiții:</span> {lot.storage_conditions}</div>
          {/if}
        </div>

        <div class="card bg-base-200 p-4 space-y-2">
          <h3 class="font-bold">Cantitate & Valabilitate</h3>
          <div><span class="text-sm opacity-60">Inițial:</span> {lot.quantity_initial} {lot.unit}</div>
          <div><span class="text-sm opacity-60">Rămas:</span> <span class="font-bold">{lot.quantity_remaining} {lot.unit}</span></div>
          {#if lot.best_before_date}
            <div><span class="text-sm opacity-60">BBD:</span> <span class="font-bold">{lot.best_before_date}</span></div>
          {/if}
          {#if lot.production_date}
            <div><span class="text-sm opacity-60">Data producție:</span> {lot.production_date}</div>
          {/if}
          <div><span class="text-sm opacity-60">Data recepție:</span> {lot.reception_date ?? lot.created_at?.slice(0, 10)}</div>
        </div>

        <div class="card bg-base-200 p-4 space-y-2">
          <h3 class="font-bold">Furnizor</h3>
          <div>{lot.supplier_name ?? 'N/A'}</div>
          {#if lot.supplier_cui}
            <div><span class="text-sm opacity-60">CUI:</span> {lot.supplier_cui}</div>
          {/if}
          {#if lot.supplier_lot_ref}
            <div><span class="text-sm opacity-60">Lot furnizor:</span> <span class="font-mono">{lot.supplier_lot_ref}</span></div>
          {/if}
          {#if lot.invoice_ref}
            <div><span class="text-sm opacity-60">Factură:</span> {lot.invoice_ref}</div>
          {/if}
        </div>

        <div class="card bg-base-200 p-4 space-y-2">
          <h3 class="font-bold">Locație</h3>
          <div>{lot.warehouse ?? 'Nespecificat'}</div>
          {#if lot.row}<div><span class="text-sm opacity-60">Rând:</span> {lot.row}</div>{/if}
          {#if lot.shelf}<div><span class="text-sm opacity-60">Raft:</span> {lot.shelf}</div>{/if}
          {#if lot.temperature_zone}<div><span class="text-sm opacity-60">Zonă:</span> {lot.temperature_zone}</div>{/if}
        </div>
      </div>
    {/if}

    {#if activeTab === 'tree'}
      {#if !upstream}
        <div class="flex justify-center py-8"><span class="loading loading-spinner"></span></div>
      {:else}
        <div class="card bg-base-200 p-4">
          <h3 class="font-bold mb-3">Materii prime (upstream)</h3>
          <pre class="text-sm font-mono whitespace-pre-wrap">{renderTree(upstream)}</pre>
        </div>
      {/if}
    {/if}

    {#if activeTab === 'timeline'}
      <div class="overflow-x-auto">
        <table class="table table-sm w-full">
          <thead>
            <tr><th>Data/Ora</th><th>Tip</th><th>Cantitate</th><th>Referință</th><th>Locație</th></tr>
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
              <tr><td colspan="5" class="text-center opacity-50 py-4">Nicio mișcare înregistrată</td></tr>
            {/if}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</div>
