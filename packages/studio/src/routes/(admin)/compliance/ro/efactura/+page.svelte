<script lang="ts">
  import { m } from '$lib/i18n.svelte.js';
  import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
  import { createExtensionConfirm } from '$lib/utils/extension-confirm.svelte.js';
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { ENGINE_URL } from '$lib/config.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { Plus, Download, Send, Trash2, FileText, LoaderCircle } from '@lucide/svelte';

  const { confirmState, askConfirm, runConfirmAction, cancelConfirm } = createExtensionConfirm();

  let invoices = $state<any[]>([]);
  let loading = $state(true);
  let showCreateModal = $state(false);
  let creating = $state(false);
  let filter = $state('all');

  let form = $state({
    invoice_number: '',
    invoice_date: new Date().toISOString().split('T')[0],
    due_date: '',
    seller_name: '',
    seller_cui: '',
    seller_address: '',
    seller_iban: '',
    buyer_name: '',
    buyer_cui: '',
    buyer_address: '',
    currency: 'RON',
    lines: [{ description: '', quantity: 1, unit: 'BUC', unit_price: 0, vat_rate: 19, vat_amount: 0, line_total: 0 }],
  });

  onMount(loadInvoices);
  $effect(() => { filter; loadInvoices(); });

  async function loadInvoices() {
    loading = true;
    try {
      const qs = filter !== 'all' ? `?status=${filter}` : '';
      const r = await api.get<{ invoices: any[] }>(`/ext/compliance/ro/efactura${qs}`);
      invoices = r.invoices ?? [];
    } catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.loadFailed']()); }
    finally { loading = false; }
  }

  function recalcLine(line: any) {
    const base = line.quantity * line.unit_price;
    line.vat_amount = Math.round(base * (line.vat_rate / 100) * 100) / 100;
    line.line_total = Math.round((base + line.vat_amount) * 100) / 100;
  }

  function addLine() {
    form.lines = [...form.lines, { description: '', quantity: 1, unit: 'BUC', unit_price: 0, vat_rate: 19, vat_amount: 0, line_total: 0 }];
  }

  function removeLine(i: number) {
    form.lines = form.lines.filter((_, idx) => idx !== i);
  }

  const totals = $derived({
    subtotal: form.lines.reduce((s, l) => s + (l.line_total - l.vat_amount), 0),
    vat_total: form.lines.reduce((s, l) => s + l.vat_amount, 0),
    total: form.lines.reduce((s, l) => s + l.line_total, 0),
  });

  async function createInvoice() {
    if (!form.invoice_number || !form.seller_name || !form.buyer_name) return;
    creating = true;
    try {
      await api.post('/ext/compliance/ro/efactura', { ...form, ...totals });
      showCreateModal = false;
      await loadInvoices();
      toast.success(m['compliance.ro.efactura.toast.created']());
    } catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.loadFailed']()); }
    finally { creating = false; }
  }

  async function generateXML(id: string) {
    try {
      await api.post(`/ext/compliance/ro/efactura/${id}/generate-xml`, {});
      toast.success(m['compliance.ro.efactura.toast.xmlGenerated']());
      await loadInvoices();
    } catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.saveFailed']()); }
  }

  async function downloadXML(id: string, number: string) {
    const res = await api.fetch(`/ext/compliance/ro/efactura/${id}/xml`);
    if (!res.ok) { toast.error(m['compliance.ro.saft.error.generateXmlFirst']()); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `factura_${number}.xml`; a.click();
    URL.revokeObjectURL(url);
  }

  async function submitToANAF(id: string) {
        askConfirm(m['compliance.ro.efactura.confirmSend'](), () => submitToANAFConfirmed(id));
  }
  async function submitToANAFConfirmed(id: string) {
    try {
      const data = await api.post<any>(`/ext/compliance/ro/efactura/${id}/submit`, {});
      toast.success(m['ext.saved']());
      await loadInvoices();
    } catch (e: any) { toast.error(e?.message ?? m['compliance.ro.efactura.toast.submissionFailed']()); }
  }


  async function deleteInvoice(id: string) {
        askConfirm(m['compliance.ro.efactura.confirmDelete'](), () => deleteInvoiceConfirmed(id));
  }
  async function deleteInvoiceConfirmed(id: string) {
    try { await api.delete(`/ext/compliance/ro/efactura/${id}`); await loadInvoices(); }
    catch (e: any) { toast.error(e instanceof Error ? e.message : m['ext.saveFailed']()); }
  }


function invoiceStatusLabel(s: string): string {
    const map: Record<string, () => string> = {
      all: () => m['common.filter.all'](),
      draft: () => m['compliance.ro.efactura.status.draft'](),
      xml_generated: () => m['compliance.ro.efactura.status.xmlGenerated'](),
      submitted: () => m['compliance.ro.efactura.status.submitted'](),
      accepted: () => m['compliance.ro.efactura.status.accepted'](),
      rejected: () => m['compliance.ro.efactura.status.rejected'](),
    };
    return (map[s] ?? (() => s))();
  }

  function statusBadge(status: string): string {
    return ({ draft: 'badge-warning', xml_generated: 'badge-info', submitted: 'badge-primary', accepted: 'badge-success', rejected: 'badge-error' } as Record<string, string>)[status] ?? 'badge-ghost';
  }
</script>

<ExtensionPageShell title={m['compliance.ro.efactura.title']()} subtitle={m['compliance.ro.efactura.subtitle']()}>
  {#snippet actions()}
    <button class="btn btn-primary btn-sm gap-1" onclick={() => (showCreateModal = true)}>
      <Plus size={14} aria-hidden="true" />
      {m['compliance.ro.efactura.btn.newInvoice']()}
    </button>
  {/snippet}

  {#snippet children()}
  <div class="tabs tabs-boxed bg-base-200 w-fit">
    {#each ['all', 'draft', 'xml_generated', 'submitted', 'accepted', 'rejected'] as s}
      <button class="tab {filter === s ? 'tab-active' : ''}" onclick={() => (filter = s)}>
        {invoiceStatusLabel(s)}
      </button>
    {/each}
  </div>

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if invoices.length === 0}
    <div class="card bg-base-200">
      <div class="card-body items-center py-12 text-base-content/50 text-sm">
        <FileText size={40} class="opacity-20 mb-2" /> {m['compliance.ro.efactura.empty.invoices']()}
      </div>
    </div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>{m['common.col.number']()}</th><th>{m['common.col.date']()}</th><th>{m['compliance.ro.efactura.col.buyer']()}</th><th>{m['common.col.total']()}</th><th>{m['common.col.status']()}</th><th>{m['compliance.ro.efactura.col.anafIndex']()}</th><th></th></tr></thead>
        <tbody>
          {#each invoices as inv (inv.id)}
            <tr class="hover">
              <td class="font-mono font-medium text-sm">{inv.invoice_number}</td>
              <td class="text-sm">{inv.invoice_date}</td>
              <td class="text-sm">{inv.buyer_name}</td>
              <td class="font-mono text-sm">{Number(inv.total).toFixed(2)} {inv.currency}</td>
              <td><span class="badge badge-sm {statusBadge(inv.status)}">{inv.status}</span></td>
              <td class="font-mono text-xs text-base-content/50">{inv.anaf_index || '—'}</td>
              <td>
                <div class="flex gap-1">
                  {#if inv.status === 'draft'}
                    <button class="btn btn-ghost btn-xs" onclick={() => generateXML(inv.id)}>{m['compliance.ro.efactura.btn.generateXml']()}</button>
                  {/if}
                  {#if inv.status === 'xml_generated' || inv.status === 'draft'}
                    <button class="btn btn-ghost btn-xs" onclick={() => downloadXML(inv.id, inv.invoice_number)}>
                      <Download size={12} />
                    </button>
                  {/if}
                  {#if inv.status === 'xml_generated'}
                    <button class="btn btn-ghost btn-xs text-primary" onclick={() => submitToANAF(inv.id)}>
                      <Send size={12} />
                    </button>
                  {/if}
                  {#if inv.status === 'draft'}
                    <button class="btn btn-ghost btn-xs text-error" onclick={() => deleteInvoice(inv.id)}>
                      <Trash2 size={12} />
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

{#if showCreateModal}
  <dialog class="modal modal-open">
    <div class="modal-box w-11/12 max-w-4xl">
      <h3 class="font-bold text-lg mb-4">{m['compliance.ro.efactura.ui.new_invoice']()}</h3>

      <div class="grid grid-cols-2 gap-4 mb-4">
        <div class="form-control">
          <label class="label" for="inv-number"><span class="label-text">{m['compliance.ro.efactura.ui.invoice_number']()}</span></label>
          <input id="inv-number" type="text" bind:value={form.invoice_number} placeholder={m['compliance.ro.efactura.ui.fac_2026_001']()} class="input input-sm" />
        </div>
        <div class="form-control">
          <label class="label" for="inv-currency"><span class="label-text">{m['crm.form.currency']()}</span></label>
          <select id="inv-currency" bind:value={form.currency} class="select select-sm">
            <option>RON</option><option>EUR</option><option>USD</option>
          </select>
        </div>
        <div class="form-control">
          <label class="label" for="inv-date"><span class="label-text">{m['compliance.ro.efactura.ui.invoice_date']()}</span></label>
          <input id="inv-date" type="date" bind:value={form.invoice_date} class="input input-sm" />
        </div>
        <div class="form-control">
          <label class="label" for="inv-due"><span class="label-text">{m['invoicing.col.dueDate']()}</span></label>
          <input id="inv-due" type="date" bind:value={form.due_date} class="input input-sm" />
        </div>
      </div>

      <div class="grid grid-cols-2 gap-4 mb-4">
        <div class="card bg-base-200 p-3">
          <p class="font-semibold text-sm mb-2">{m['compliance.ro.efactura.section.seller']()}</p>
          <div class="space-y-2">
            <input type="text" bind:value={form.seller_name} placeholder={m['compliance.ro.efactura.ui.company_name']()} class="input input-sm w-full" />
            <input type="text" bind:value={form.seller_cui} placeholder={m['compliance.ro.efactura.ui.cui_cif']()} class="input input-sm w-full font-mono" />
            <input type="text" bind:value={form.seller_address} placeholder={m['hr.employees.form.address']()} class="input input-sm w-full" />
            <input type="text" bind:value={form.seller_iban} placeholder={m['common.col.iban']()} class="input input-sm w-full font-mono" />
          </div>
        </div>
        <div class="card bg-base-200 p-3">
          <p class="font-semibold text-sm mb-2">{m['compliance.ro.efactura.section.buyer']()}</p>
          <div class="space-y-2">
            <input type="text" bind:value={form.buyer_name} placeholder={m['compliance.ro.efactura.ui.company_person_name']()} class="input input-sm w-full" />
            <input type="text" bind:value={form.buyer_cui} placeholder={m['compliance.ro.efactura.ui.cui_cif_optional']()} class="input input-sm w-full font-mono" />
            <input type="text" bind:value={form.buyer_address} placeholder={m['hr.employees.form.address']()} class="input input-sm w-full" />
          </div>
        </div>
      </div>

      <div class="mb-4">
        <div class="flex items-center justify-between mb-2">
          <p class="font-semibold text-sm">{m['compliance.ro.efactura.section.lines']()}</p>
          <button class="btn btn-ghost btn-xs" onclick={addLine}>{m['compliance.ro.efactura.ui.add_line']()}</button>
        </div>
        <div class="overflow-x-auto">
          <table class="table table-xs">
            <thead><tr><th>{m['common.col.description']()}</th><th>{m['compliance.ro.efactura.col.qty']()}</th><th>{m['compliance.ro.efactura.col.unit']()}</th><th>{m['common.col.price']()}</th><th>{m['compliance.ro.efactura.col.vatPercent']()}</th><th>{m['compliance.ro.efactura.col.vat']()}</th><th>{m['common.col.total']()}</th><th></th></tr></thead>
            <tbody>
              {#each form.lines as line, i}
                <tr>
                  <td><input type="text" bind:value={line.description} class="input input-xs w-40" /></td>
                  <td><input type="number" bind:value={line.quantity} oninput={() => recalcLine(line)} class="input input-xs w-16" /></td>
                  <td><input type="text" bind:value={line.unit} class="input input-xs w-16" /></td>
                  <td><input type="number" step="0.01" bind:value={line.unit_price} oninput={() => recalcLine(line)} class="input input-xs w-24" /></td>
                  <td>
                    <select bind:value={line.vat_rate} onchange={() => recalcLine(line)} class="select select-xs w-16">
                      <option value={0}>0%</option><option value={5}>5%</option><option value={9}>9%</option><option value={19}>19%</option>
                    </select>
                  </td>
                  <td class="font-mono text-xs">{line.vat_amount.toFixed(2)}</td>
                  <td class="font-mono text-xs font-medium">{line.line_total.toFixed(2)}</td>
                  <td>
                    {#if form.lines.length > 1}
                      <button onclick={() => removeLine(i)} class="btn btn-ghost btn-xs text-error">✕</button>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <div class="text-right text-sm mt-2 space-y-1">
          <p>{m['compliance.ro.efactura.totals.subtotal']()}: <strong class="font-mono">{totals.subtotal.toFixed(2)} {form.currency}</strong></p>
          <p>{m['compliance.ro.efactura.totals.vat']()}: <strong class="font-mono">{totals.vat_total.toFixed(2)} {form.currency}</strong></p>
          <p class="text-base font-bold">{m['compliance.ro.efactura.totals.total']()}: <strong class="font-mono">{totals.total.toFixed(2)} {form.currency}</strong></p>
        </div>
      </div>

      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => (showCreateModal = false)}>{m['common.cancel']()}</button>
        <button class="btn btn-primary" onclick={createInvoice} disabled={creating || !form.invoice_number || !form.seller_name || !form.buyer_name}>
          {#if creating}<span class="loading loading-spinner loading-sm"></span>{/if} {m['compliance.ro.efactura.btn.createInvoice']()}
        </button>
      </div>
    </div>
    <button class="modal-backdrop" onclick={() => (showCreateModal = false)}></button>
  </dialog>
{/if}
