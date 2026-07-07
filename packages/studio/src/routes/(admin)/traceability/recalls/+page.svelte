<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
import { createExtensionConfirm } from '$lib/utils/extension-confirm.svelte.js';
import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
import { api } from '$lib/api.js';
const { confirmState, askConfirm, runConfirmAction, cancelConfirm } = createExtensionConfirm();

const API = '/ext/operations/traceability';

type Tab = 'simulate' | 'active';

let activeTab = $state<Tab>('simulate');
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let recalls = $state<any[]>([]);
let loadingRecalls = $state(false);

let lotId = $state('');
let simulating = $state(false);
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let simulation = $state<any>(null);
let simError = $state('');

let initiateForm = $state({ reason: '', scope: 'internal' as string });
let initiating = $state(false);
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let initiated = $state<any>(null);

let resolveForm = $state({ recallId: '', resolution_notes: '' });
let resolving = $state(false);

$effect(() => {
  if (activeTab === 'active') loadRecalls();
});

async function loadRecalls() {
  loadingRecalls = true;
  const res = await api.fetch(`${API}/recalls?status=active`);
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
    const res = await api.fetch(`${API}/recalls/simulate/${lotId.trim()}`, { method: 'POST' });
    if (!res.ok) throw new Error(await res.text());
    simulation = (await res.json()).data;
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    simError = e.message;
  } finally {
    simulating = false;
  }
}

async function initiateRecall(e: Event) {
  e.preventDefault();
  askConfirm(m['operations.traceability.recalls.confirm']({ scope: initiateForm.scope }), () =>
    initiateRecallConfirmed(e),
  );
}
async function initiateRecallConfirmed(e: Event) {
  initiating = true;
  simError = '';
  try {
    const res = await api.fetch(`${API}/recalls/initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lot_id: lotId.trim(),
        reason: initiateForm.reason,
        scope: initiateForm.scope,
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    initiated = (await res.json()).data;
    simulation = null;
    await loadRecalls();
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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
    const res = await api.fetch(`${API}/recalls/${resolveForm.recallId}/resolve`, {
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
  return (
    { consumer_recall: 'alert-error', market_withdrawal: 'alert-warning', internal: 'alert-info' }[
      action
    ] ?? 'alert-info'
  );
}
</script>

<ExtensionPageShell title={m['operations.traceability.recalls.title']()}>
  <div class="p-6 space-y-4 pt-0">
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
        <h3 class="font-semibold mb-3">{m['operations.traceability.ui.pasul_1_identifica_i_lotul_suspect']()}</h3>
        <div class="flex gap-2">
          <input
            type="text"
            class="input input-bordered flex-1"
            placeholder={m['operations.traceability.ui.uuid_lot_sau_scana_i_qr_ul']()}
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
                <div class="text-sm">{m['operations.traceability.recalls.affectedLots']()}</div>
              </div>
              <div>
                <div class="text-3xl font-bold">{simulation.total_customers_affected}</div>
                <div class="text-sm">{m['operations.traceability.recalls.affectedClients']()}</div>
              </div>
              <div>
                <div class="text-3xl font-bold">{simulation.affected_customers.length}</div>
                <div class="text-sm">{m['operations.traceability.recalls.affectedDeliveries']()}</div>
              </div>
            </div>
          </div>
        </div>

        {#if simulation.affected_lots.length > 0}
          <div class="card bg-base-200 p-4">
            <h4 class="font-semibold mb-2">{m['operations.traceability.recalls.finishedLots']()}</h4>
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
          <h3 class="font-bold text-error mb-3">{m['operations.traceability.ui.pasul_2_declan_are_recall_real']()}</h3>
          <p class="text-sm mb-3 opacity-70">{m['operations.traceability.recalls.warning']()}</p>
          <form onsubmit={initiateRecall} class="space-y-3">
            <div>
              <label class="label-text font-medium">{m['operations.traceability.recalls.reason']()}</label>
              <textarea class="textarea textarea-bordered w-full" rows="2"
                placeholder={m['operations.traceability.ui.descrie_i_motivul_retragerii_min_10_caractere']()}
                bind:value={initiateForm.reason}
                required
                minlength={10}
              ></textarea>
            </div>
            <div>
              <label class="label-text font-medium">{m['operations.traceability.recalls.type']()}</label>
              <select class="select select-bordered w-full" bind:value={initiateForm.scope}>
                <option value="internal">{m['operations.traceability.ui.internal_f_r_distribu_ie_extern']()}</option>
                <option value="market_withdrawal">{m['operations.traceability.ui.retragere_de_pe_pia']()}</option>
                <option value="consumer_recall">{m['operations.traceability.ui.recall_consumatori']()}</option>
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
      <div class="text-center opacity-50 py-12">{m['operations.traceability.recalls.noneActive']()}</div>
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
                <input type="text" class="input input-bordered input-sm flex-1" placeholder={m['operations.traceability.ui.note_rezolvare_min_5_caractere']()} bind:value={resolveForm.resolution_notes} required minlength={5} />
                <button type="submit" class="btn btn-sm btn-success" disabled={resolving}>{m['operations.traceability.ui.confirm']()}</button>
                <button type="button" class="btn btn-sm btn-ghost" onclick={() => resolveForm = { recallId: '', resolution_notes: '' }}>{m['common.cancel']()}</button>
              </form>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
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
