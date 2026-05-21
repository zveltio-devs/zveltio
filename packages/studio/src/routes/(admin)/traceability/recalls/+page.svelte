<script lang="ts">
  const API = '/ext/operations/traceability';

  type Tab = 'simulate' | 'active';

  let activeTab = $state<Tab>('simulate');
  let recalls = $state<any[]>([]);
  let loadingRecalls = $state(false);

  let lotId = $state('');
  let simulating = $state(false);
  let simulation = $state<any>(null);
  let simError = $state('');

  let initiateForm = $state({ reason: '', scope: 'internal' as string });
  let initiating = $state(false);
  let initiated = $state<any>(null);

  let resolveForm = $state({ recallId: '', resolution_notes: '' });
  let resolving = $state(false);

  $effect(() => {
    if (activeTab === 'active') loadRecalls();
  });

  async function loadRecalls() {
    loadingRecalls = true;
    const res = await fetch(`${API}/recalls?status=active`);
    recalls = res.ok ? (await res.json()).data : [];
    loadingRecalls = false;
  }

  async function simulate() {
    if (!lotId.trim()) return;
    simulating = true;
    simError = '';
    simulation = null;
    initiated = null;
    try {
      const res = await fetch(`${API}/recalls/simulate/${lotId.trim()}`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      simulation = (await res.json()).data;
    } catch (e: any) {
      simError = e.message;
    } finally {
      simulating = false;
    }
  }

  async function initiateRecall(e: Event) {
    e.preventDefault();
    if (!confirm(`Confirmați declanșarea unui recall REAL (${initiateForm.scope})?`)) return;
    initiating = true;
    simError = '';
    try {
      const res = await fetch(`${API}/recalls/initiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lot_id: lotId.trim(), reason: initiateForm.reason, scope: initiateForm.scope }),
      });
      if (!res.ok) throw new Error(await res.text());
      initiated = (await res.json()).data;
      simulation = null;
      await loadRecalls();
    } catch (e: any) {
      simError = e.message;
    } finally {
      initiating = false;
    }
  }

  async function resolveRecall(e: Event) {
    e.preventDefault();
    resolving = true;
    try {
      const res = await fetch(`${API}/recalls/${resolveForm.recallId}/resolve`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolution_notes: resolveForm.resolution_notes }),
      });
      if (!res.ok) throw new Error(await res.text());
      resolveForm = { recallId: '', resolution_notes: '' };
      await loadRecalls();
    } finally {
      resolving = false;
    }
  }

  function actionColor(action: string): string {
    return { consumer_recall: 'alert-error', market_withdrawal: 'alert-warning', internal: 'alert-info' }[action] ?? 'alert-info';
  }
</script>

<div class="p-6 space-y-4">
  <h1 class="text-2xl font-bold">Recall / Retragere produs</h1>

  <div class="tabs tabs-bordered">
    <button class="tab {activeTab === 'simulate' ? 'tab-active' : ''}" onclick={() => activeTab = 'simulate'}>
      Simulator recall
    </button>
    <button class="tab {activeTab === 'active' ? 'tab-active' : ''}" onclick={() => activeTab = 'active'}>
      Recall-uri active {#if recalls.length}<span class="badge badge-error badge-sm ml-1">{recalls.length}</span>{/if}
    </button>
  </div>

  {#if activeTab === 'simulate'}
    <div class="max-w-xl space-y-4">
      <div class="card bg-base-200 p-4">
        <h3 class="font-semibold mb-3">Pasul 1 — Identificați lotul suspect</h3>
        <div class="flex gap-2">
          <input
            type="text"
            class="input input-bordered flex-1"
            placeholder="UUID lot sau scanați QR-ul..."
            bind:value={lotId}
          />
          <button class="btn btn-primary" onclick={simulate} disabled={simulating || !lotId.trim()}>
            {simulating ? 'Calculez...' : 'Simulare'}
          </button>
        </div>
      </div>

      {#if simError}
        <div class="alert alert-error">{simError}</div>
      {/if}

      {#if simulation}
        <div class="alert {actionColor(simulation.recommended_action)}">
          <div>
            <div class="font-bold text-lg">
              Acțiune recomandată: <span class="uppercase">{simulation.recommended_action.replace('_', ' ')}</span>
            </div>
            <div class="mt-2 grid grid-cols-3 gap-4 text-center">
              <div>
                <div class="text-3xl font-bold">{simulation.total_lots_affected}</div>
                <div class="text-sm">Loturi afectate</div>
              </div>
              <div>
                <div class="text-3xl font-bold">{simulation.total_customers_affected}</div>
                <div class="text-sm">Clienți afectați</div>
              </div>
              <div>
                <div class="text-3xl font-bold">{simulation.affected_customers.length}</div>
                <div class="text-sm">Livrări afectate</div>
              </div>
            </div>
          </div>
        </div>

        {#if simulation.affected_lots.length > 0}
          <div class="card bg-base-200 p-4">
            <h4 class="font-semibold mb-2">Loturi finite afectate</h4>
            <div class="space-y-1">
              {#each simulation.affected_lots as lot}
                <div class="text-sm flex justify-between py-1 border-b border-base-300">
                  <span class="font-mono">{lot.lot_number}</span>
                  <span>{lot.item_name}</span>
                  <span>{lot.quantity_remaining} {lot.unit}</span>
                  <span class="badge badge-sm badge-outline">{lot.status}</span>
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <div class="card bg-base-200 p-4">
          <h3 class="font-bold text-error mb-3">⚠ Pasul 2 — Declanșare recall REAL</h3>
          <p class="text-sm mb-3 opacity-70">Aceasta va marca toate loturile afectate ca "recalled" și va crea un dosar oficial.</p>
          <form onsubmit={initiateRecall} class="space-y-3">
            <div>
              <label class="label-text font-medium">Motiv recall *</label>
              <textarea class="textarea textarea-bordered w-full" rows="2"
                placeholder="Descrieți motivul retragerii (min 10 caractere)..."
                bind:value={initiateForm.reason}
                required
                minlength={10}
              ></textarea>
            </div>
            <div>
              <label class="label-text font-medium">Tip recall</label>
              <select class="select select-bordered w-full" bind:value={initiateForm.scope}>
                <option value="internal">Internal (fără distribuție externă)</option>
                <option value="market_withdrawal">Retragere de pe piață</option>
                <option value="consumer_recall">Recall consumatori</option>
              </select>
            </div>
            <button type="submit" class="btn btn-error w-full" disabled={initiating || !initiateForm.reason.trim()}>
              {initiating ? 'Se procesează...' : '🚨 Declanșează recall REAL'}
            </button>
          </form>
        </div>
      {/if}

      {#if initiated}
        <div class="alert alert-success">
          Recall declanșat cu succes. ID: <span class="font-mono">{initiated.id}</span>
        </div>
      {/if}
    </div>
  {/if}

  {#if activeTab === 'active'}
    {#if loadingRecalls}
      <div class="flex justify-center py-8"><span class="loading loading-spinner"></span></div>
    {:else if recalls.length === 0}
      <div class="text-center opacity-50 py-12">Niciun recall activ</div>
    {:else}
      <div class="space-y-3">
        {#each recalls as recall}
          <div class="card bg-base-200 p-4">
            <div class="flex items-start justify-between">
              <div>
                <div class="font-bold">{recall.item_name} — <span class="font-mono">{recall.lot_number}</span></div>
                <div class="text-sm opacity-70">{new Date(recall.initiated_at).toLocaleString('ro-RO')}</div>
                <div class="text-sm mt-1">{recall.reason}</div>
                <span class="badge badge-error badge-sm mt-1">{recall.scope.replace('_', ' ')}</span>
              </div>
              <button class="btn btn-sm btn-outline" onclick={() => { resolveForm.recallId = recall.id; }}>
                Rezolvă
              </button>
            </div>

            {#if resolveForm.recallId === recall.id}
              <form onsubmit={resolveRecall} class="mt-3 flex gap-2">
                <input type="text" class="input input-bordered input-sm flex-1" placeholder="Note rezolvare (min 5 caractere)..." bind:value={resolveForm.resolution_notes} required minlength={5} />
                <button type="submit" class="btn btn-sm btn-success" disabled={resolving}>Confirmă</button>
                <button type="button" class="btn btn-sm btn-ghost" onclick={() => resolveForm = { recallId: '', resolution_notes: '' }}>Anulează</button>
              </form>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>
