<script lang="ts">
 import { onMount } from 'svelte';
 import { Plus, Download, Send, Trash2, FileText } from '@lucide/svelte';

 const engineUrl = (window as any).__ZVELTIO_ENGINE_URL__ || '';

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

 onMount(() => loadInvoices());

 async function loadInvoices() {
 loading = true;
 try {
 const qs = filter !== 'all' ? `?status=${filter}` : '';
 const res = await fetch(`${engineUrl}/api/efactura${qs}`, { credentials: 'include' });
 const data = await res.json();
 invoices = data.invoices || [];
 } finally {
 loading = false;
 }
 }

 $effect(() => { if (filter) loadInvoices(); });

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
 const res = await fetch(`${engineUrl}/api/efactura`, {
 method: 'POST',
 credentials: 'include',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ ...form, ...totals }),
 });
 if (!res.ok) throw new Error('Failed');
 showCreateModal = false;
 await loadInvoices();
 } catch (e) {
 alert('Failed to create invoice');
 } finally {
 creating = false;
 }
 }

 async function generateXML(id: string) {
 const res = await fetch(`${engineUrl}/api/efactura/${id}/generate-xml`, {
 method: 'POST',
 credentials: 'include',
 });
 if (res.ok) {
 alert('XML generated! Use Download to get the file.');
 await loadInvoices();
 }
 }

 async function downloadXML(id: string, number: string) {
 const res = await fetch(`${engineUrl}/api/efactura/${id}/xml`, { credentials: 'include' });
 if (!res.ok) { alert('Generate XML first'); return; }
 const blob = await res.blob();
 const url = URL.createObjectURL(blob);
 const a = document.createElement('a');
 a.href = url;
 a.download = `factura_${number}.xml`;
 a.click();
 URL.revokeObjectURL(url);
 }

 async function submitToANAF(id: string) {
 if (!confirm('Submit this invoice to ANAF e-Factura?')) return;
 const res = await fetch(`${engineUrl}/api/efactura/${id}/submit`, {
 method: 'POST',
 credentials: 'include',
 });
 const data = await res.json();
 if (res.ok) {
 alert(`Submitted! ANAF index: ${data.anaf_index}`);
 await loadInvoices();
 } else {
 alert(data.error || 'Submission failed');
 }
 }

 async function deleteInvoice(id: string) {
 if (!confirm('Delete this invoice?')) return;
 await fetch(`${engineUrl}/api/efactura/${id}`, { method: 'DELETE', credentials: 'include' });
 await loadInvoices();
 }

 function statusBadge(status: string): string {
 const map: Record<string, string> = {
 draft: 'badge-warning',
 xml_generated: 'badge-info',
 submitted: 'badge-primary',
 accepted: 'badge-success',
 rejected: 'badge-error',
 };
 return map[status] || 'badge-ghost';
 }
</script>

<div class="space-y-6">
 <div class="flex items-center justify-between">
 <div>
 <h1 class="text-2xl font-bold">e-Factura RO</h1>
 <p class="text-base-content/60 text-sm mt-1">Generate and submit UBL XML invoices to ANAF</p>
 </div>
 <button class="btn btn-primary btn-sm gap-2" onclick={() => (showCreateModal = true)}>
 <Plus size={16} />
 New Invoice
 </button>
 </div>

 <div class="tabs tabs-boxed w-fit">
 {#each ['all', 'draft', 'xml_generated', 'submitted', 'accepted', 'rejected'] as s}
 <button class="tab {filter === s ? 'tab-active' : ''}" onclick={() => (filter = s)}>
 {s === 'all' ? 'All' : s.replace('_', ' ')}
 </button>
 {/each}
 </div>

 {#if loading}
 <div class="flex justify-center py-12"><span class="loading loading-spinner loading-lg"></span></div>
 {:else if invoices.length === 0}
 <div class="card bg-base-200 text-center py-12">
 <FileText size={48} class="mx-auto text-base-content/20 mb-3" />
 <p class="text-base-content/60">No invoices</p>
 <button class="btn btn-primary btn-sm mt-4" onclick={() => (showCreateModal = true)}>Create Invoice</button>
 </div>
 {:else}
 <div class="card bg-base-200">
 <div class="overflow-x-auto">
 <table class="table table-sm">
 <thead>
 <tr>
 <th>Number</th>
 <th>Date</th>
 <th>Buyer</th>
 <th>Total</th>
 <th>Status</th>
 <th>ANAF Index</th>
 <th></th>
 </tr>
 </thead>
 <tbody>
 {#each invoices as inv}
 <tr>
 <td class="font-mono font-medium">{inv.invoice_number}</td>
 <td>{inv.invoice_date}</td>
 <td>{inv.buyer_name}</td>
 <td class="font-mono">{Number(inv.total).toFixed(2)} {inv.currency}</td>
 <td><span class="badge badge-sm {statusBadge(inv.status)}">{inv.status}</span></td>
 <td class="font-mono text-xs text-base-content/50">{inv.anaf_index || '—'}</td>
 <td>
 <div class="flex gap-1">
 {#if inv.status === 'draft'}
 <button class="btn btn-ghost btn-xs" onclick={() => generateXML(inv.id)} title="Generate XML">XML</button>
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
 </div>
 {/if}
</div>

{#if showCreateModal}
 <dialog class="modal modal-open">
 <div class="modal-box w-11/12 max-w-4xl">
 <h3 class="font-bold text-lg mb-4">New Invoice</h3>

 <div class="grid grid-cols-2 gap-4 mb-4">
 <div class="form-control">
 <label class="label"><span class="label-text">Invoice number</span></label>
 <input type="text" bind:value={form.invoice_number} placeholder="FAC-2026-001" class="input input-sm" />
 </div>
 <div class="form-control">
 <label class="label"><span class="label-text">Currency</span></label>
 <select bind:value={form.currency} class="select select-sm">
 <option>RON</option><option>EUR</option><option>USD</option>
 </select>
 </div>
 <div class="form-control">
 <label class="label"><span class="label-text">Invoice date</span></label>
 <input type="date" bind:value={form.invoice_date} class="input input-sm" />
 </div>
 <div class="form-control">
 <label class="label"><span class="label-text">Due date</span></label>
 <input type="date" bind:value={form.due_date} class="input input-sm" />
 </div>
 </div>

 <div class="grid grid-cols-2 gap-4 mb-4">
 <div class="card bg-base-200 p-3">
 <p class="font-semibold text-sm mb-2">Seller (Emitent)</p>
 <div class="space-y-2">
 <input type="text" bind:value={form.seller_name} placeholder="Company name" class="input input-sm w-full" />
 <input type="text" bind:value={form.seller_cui} placeholder="CUI/CIF" class="input input-sm w-full font-mono" />
 <input type="text" bind:value={form.seller_address} placeholder="Address" class="input input-sm w-full" />
 <input type="text" bind:value={form.seller_iban} placeholder="IBAN" class="input input-sm w-full font-mono" />
 </div>
 </div>
 <div class="card bg-base-200 p-3">
 <p class="font-semibold text-sm mb-2">Buyer (Beneficiar)</p>
 <div class="space-y-2">
 <input type="text" bind:value={form.buyer_name} placeholder="Company/person name" class="input input-sm w-full" />
 <input type="text" bind:value={form.buyer_cui} placeholder="CUI/CIF (optional)" class="input input-sm w-full font-mono" />
 <input type="text" bind:value={form.buyer_address} placeholder="Address" class="input input-sm w-full" />
 </div>
 </div>
 </div>

 <!-- Lines -->
 <div class="mb-4">
 <div class="flex items-center justify-between mb-2">
 <p class="font-semibold text-sm">Invoice lines</p>
 <button class="btn btn-ghost btn-xs" onclick={addLine}>+ Add line</button>
 </div>
 <div class="overflow-x-auto">
 <table class="table table-xs">
 <thead>
 <tr><th>Description</th><th>Qty</th><th>Unit</th><th>Price</th><th>VAT%</th><th>VAT</th><th>Total</th><th></th></tr>
 </thead>
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
 <p>Subtotal: <strong class="font-mono">{totals.subtotal.toFixed(2)} {form.currency}</strong></p>
 <p>TVA: <strong class="font-mono">{totals.vat_total.toFixed(2)} {form.currency}</strong></p>
 <p class="text-base font-bold">Total: <strong class="font-mono">{totals.total.toFixed(2)} {form.currency}</strong></p>
 </div>
 </div>

 <div class="modal-action">
 <button class="btn btn-ghost" onclick={() => (showCreateModal = false)}>Cancel</button>
 <button class="btn btn-primary" onclick={createInvoice} disabled={creating}>
 {#if creating}<span class="loading loading-spinner loading-sm"></span>{/if}
 Create Invoice
 </button>
 </div>
 </div>
 <button class="modal-backdrop" onclick={() => (showCreateModal = false)}></button>
 </dialog>
{/if}
