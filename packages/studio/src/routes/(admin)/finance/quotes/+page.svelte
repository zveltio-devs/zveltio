<script lang="ts">
  import { m } from '$lib/i18n.svelte.js';
  import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
  import { createExtensionConfirm } from '$lib/utils/extension-confirm.svelte.js';
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { Plus, X, LoaderCircle, FileText, Send, Check, RotateCcw, Trash2, ExternalLink } from '@lucide/svelte';

  const { confirmState, askConfirm, runConfirmAction, cancelConfirm } = createExtensionConfirm();

  type Quote = {
    id: string; quote_number: string; client_name: string; client_email: string | null;
    status: string; total: number; currency: string; valid_until: string | null;
    approval_status: string | null; created_at: string;
  };

  let quotes = $state<Quote[]>([]);
  let loading = $state(true);
  let showModal = $state(false);
  let saving = $state(false);
  let actionId = $state<string | null>(null);

  let form = $state({
    client_name: '', client_email: '', client_address: '',
    currency: 'RON', valid_days: 30, notes: '', footer_notes: '',
    lines: [{ description: '', quantity: 1, unit_price: 0, tax_rate: 19, discount: 0 }],
  });

  onMount(load);

  async function load() {
    loading = true;
    try {
      const r = await api.get<{ data: Quote[] }>('/ext/finance/quotes');
      quotes = r.data ?? [];
    } catch (e: any) {
      toast.error(e instanceof Error ? e.message : m['ext.loadFailed']());
    } finally {
      loading = false;
    }
  }

  function addLine() {
    form.lines = [...form.lines, { description: '', quantity: 1, unit_price: 0, tax_rate: 19, discount: 0 }];
  }
  function removeLine(i: number) {
    form.lines = form.lines.filter((_, idx) => idx !== i);
  }

  async function create() {
    if (!form.client_name.trim()) return;
    saving = true;
    try {
      const r = await api.post<{ data: Quote }>('/ext/finance/quotes', form);
      quotes = [r.data, ...quotes];
      showModal = false;
      toast.success(m['finance.quotes.toast.created']());
    } catch (e: any) {
      toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
    } finally {
      saving = false;
    }
  }

  async function doAction(id: string, action: string) {
    actionId = id;
    try {
      await api.post(`/ext/finance/quotes/${id}/${action}`, {});
      await load();
      toast.success(m['ext.saved']());
    } catch (e: any) {
      toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
    } finally {
      actionId = null;
    }
  }

  async function deleteQuote(id: string) {
        askConfirm(m['finance.quotes.deleteConfirm'](), () => deleteQuoteConfirmed(id));
  }
  async function deleteQuoteConfirmed(id: string) {
    actionId = id;
    try {
      await api.delete(`/ext/finance/quotes/${id}`);
      quotes = quotes.filter(q => q.id !== id);
      toast.success(m['ext.deleted']());
    } catch (e: any) {
      toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
    } finally {
      actionId = null;
    }
  }


  const statusColor: Record<string, string> = {
    draft: 'badge-ghost', sent: 'badge-info', accepted: 'badge-success',
    rejected: 'badge-error', expired: 'badge-warning',
  };
</script>

<ExtensionPageShell title={m['finance.quotes.title']()} subtitle={m['finance.quotes.subtitle']()}>
  {#snippet actions()}
    <button class="btn btn-primary btn-sm gap-1" onclick={() => (showModal = true)}>
      <Plus size={14} /> {m['finance.quotes.btn.new']()}
    </button>
  {/snippet}

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if quotes.length === 0}
    <div class="card bg-base-200">
      <div class="card-body items-center py-16 gap-3">
        <FileText size={36} class="text-base-content/20" />
        <p class="text-sm text-base-content/50">{m['finance.quotes.empty']()}</p>
      </div>
    </div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead>
          <tr><th>{m['common.col.number']()}</th><th>{m['common.col.client']()}</th><th>{m['common.col.total']()}</th><th>{m['common.col.status']()}</th><th>{m['common.col.validUntil']()}</th><th>{m['common.col.created']()}</th><th>{m['common.actions']()}</th></tr>
        </thead>
        <tbody>
          {#each quotes as q (q.id)}
            <tr class="hover">
              <td class="font-mono text-xs font-medium">{q.quote_number}</td>
              <td>
                <div class="font-medium text-sm">{q.client_name}</div>
                {#if q.client_email}<div class="text-xs text-base-content/50">{q.client_email}</div>{/if}
              </td>
              <td class="font-medium">{q.total.toLocaleString()} {q.currency}</td>
              <td><span class="badge badge-sm {statusColor[q.status] ?? 'badge-ghost'}">{q.status}</span></td>
              <td class="text-xs text-base-content/50">{q.valid_until ? new Date(q.valid_until).toLocaleDateString() : '—'}</td>
              <td class="text-xs text-base-content/40">{new Date(q.created_at).toLocaleDateString()}</td>
              <td>
                <div class="flex items-center gap-1">
                  {#if q.status === 'draft'}
                    <button class="btn btn-xs btn-ghost gap-1" title={m['finance.quotes.btn.send']()} disabled={actionId === q.id}
                      onclick={() => doAction(q.id, 'send')}>
                      <Send size={11} />
                    </button>
                  {/if}
                  {#if q.status === 'sent'}
                    <button class="btn btn-xs btn-success btn-ghost gap-1" title={m['finance.quotes.btn.accept']()} disabled={actionId === q.id}
                      onclick={() => doAction(q.id, 'accept')}>
                      <Check size={11} />
                    </button>
                  {/if}
                  <button class="btn btn-xs btn-ghost text-error" title={m['common.delete']()} disabled={actionId === q.id}
                    onclick={() => deleteQuote(q.id)}>
                    {#if actionId === q.id}<LoaderCircle size={11} class="animate-spin" />{:else}<Trash2 size={11} />{/if}
                  </button>
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

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

<!-- Create Modal -->
{#if showModal}
  <div class="modal modal-open">
    <div class="modal-box max-w-2xl">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">{m['quotes.new']()}</h3>
        <button class="btn btn-ghost btn-xs" onclick={() => (showModal = false)}><X size={14} /></button>
      </div>

      <div class="space-y-4">
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control col-span-2 sm:col-span-1">
            <label class="label py-0"><span class="label-text text-xs">{m['finance.quotes.ui.client_name']()}</span></label>
            <input class="input input-sm" bind:value={form.client_name} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['finance.quotes.ui.client_email']()}</span></label>
            <input class="input input-sm" type="email" bind:value={form.client_email} />
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['crm.form.currency']()}</span></label>
            <select class="select select-sm" bind:value={form.currency}>
              <option>RON</option><option>EUR</option><option>USD</option>
            </select>
          </div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['finance.quotes.ui.valid_days']()}</span></label>
            <input class="input input-sm" type="number" bind:value={form.valid_days} />
          </div>
        </div>

        <div>
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs font-medium text-base-content/70">{m['finance.quotes.section.lines']()}</span>
            <button class="btn btn-xs btn-ghost gap-1" onclick={addLine}><Plus size={11} /> {m['finance.quotes.btn.addLine']()}</button>
          </div>
          <div class="space-y-2">
            {#each form.lines as line, i (i)}
              <div class="grid grid-cols-12 gap-1.5 items-end">
                <div class="col-span-5 form-control">
                  {#if i === 0}<label class="label py-0"><span class="label-text text-xs">{m['common.col.description']()}</span></label>{/if}
                  <input class="input input-xs" placeholder={m['finance.quotes.ui.service_or_product']()} bind:value={line.description} />
                </div>
                <div class="col-span-1 form-control">
                  {#if i === 0}<label class="label py-0"><span class="label-text text-xs">{m['invoicing.form.qty']()}</span></label>{/if}
                  <input class="input input-xs" type="number" bind:value={line.quantity} />
                </div>
                <div class="col-span-2 form-control">
                  {#if i === 0}<label class="label py-0"><span class="label-text text-xs">{m['finance.quotes.ui.unit_price']()}</span></label>{/if}
                  <input class="input input-xs" type="number" bind:value={line.unit_price} />
                </div>
                <div class="col-span-2 form-control">
                  {#if i === 0}<label class="label py-0"><span class="label-text text-xs">{m['invoicing.form.taxPercent']()}</span></label>{/if}
                  <input class="input input-xs" type="number" bind:value={line.tax_rate} />
                </div>
                <div class="col-span-1 form-control">
                  {#if i === 0}<label class="label py-0"><span class="label-text text-xs">{m['finance.quotes.ui.disc']()}</span></label>{/if}
                  <input class="input input-xs" type="number" bind:value={line.discount} />
                </div>
                <div class="col-span-1 flex items-end pb-0.5">
                  <button class="btn btn-ghost btn-xs text-error" onclick={() => removeLine(i)} disabled={form.lines.length === 1}>
                    <X size={11} />
                  </button>
                </div>
              </div>
            {/each}
          </div>
        </div>

        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['common.col.notes']()}</span></label>
          <textarea class="textarea textarea-sm" rows={2} bind:value={form.notes}></textarea>
        </div>
      </div>

      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showModal = false)}>{m['common.cancel']()}</button>
        <button class="btn btn-primary btn-sm gap-1" onclick={create} disabled={!form.client_name.trim() || saving}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if} {m['finance.quotes.btn.create']()}
        </button>
      </div>
    </div>
  </div>
{/if}
