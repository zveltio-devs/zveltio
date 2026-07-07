<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
import { api } from '$lib/api.js';
const API = '/ext/operations/traceability';

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let items = $state<any[]>([]);
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let suppliers = $state<any[]>([]);
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let locations = $state<any[]>([]);
let saving = $state(false);
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let saved = $state<any>(null);
let error = $state('');

let form = $state({
  item_id: '',
  lot_type: 'inbound' as const,
  quantity_initial: '',
  unit: 'kg',
  supplier_id: '',
  supplier_lot_ref: '',
  best_before_date: '',
  production_date: '',
  reception_date: new Date().toISOString().slice(0, 10),
  invoice_ref: '',
  location_id: '',
  notes: '',
  gs1_raw: '',
});

$effect(() => {
  Promise.all([
    api
      .fetch(`${API}/items?type=raw`)
      .then((r) => r.json())
      .then((d) => {
        items = d.data ?? [];
      }),
    api
      .fetch(`${API}/suppliers`)
      .then((r) => r.json())
      .then((d) => {
        suppliers = d.data ?? [];
      }),
    api
      .fetch(`${API}/locations`)
      .then((r) => r.json())
      .then((d) => {
        locations = d.data ?? [];
      }),
  ]);
});

async function parseGS1() {
  if (!form.gs1_raw.trim()) return;
  try {
    const res = await api.fetch(`${API}/scan/parse-gs1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: form.gs1_raw }),
    });
    const data = (await res.json()).data;
    if (data.supplier_lot_ref) form.supplier_lot_ref = data.supplier_lot_ref;
    if (data.best_before_date) form.best_before_date = data.best_before_date;
  } catch {}
}

async function submit(e: Event) {
  e.preventDefault();
  saving = true;
  error = '';
  saved = null;

  try {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const payload: any = {
      item_id: form.item_id,
      lot_type: form.lot_type,
      quantity_initial: parseFloat(form.quantity_initial),
      unit: form.unit,
      reception_date: form.reception_date,
    };
    if (form.supplier_id) payload.supplier_id = form.supplier_id;
    if (form.supplier_lot_ref) payload.supplier_lot_ref = form.supplier_lot_ref;
    if (form.best_before_date) payload.best_before_date = form.best_before_date;
    if (form.production_date) payload.production_date = form.production_date;
    if (form.invoice_ref) payload.invoice_ref = form.invoice_ref;
    if (form.location_id) payload.location_id = form.location_id;
    if (form.notes) payload.notes = form.notes;

    const res = await api.fetch(`${API}/lots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) throw new Error(await res.text());
    saved = (await res.json()).data;

    // Reset form
    form = {
      ...form,
      item_id: '',
      quantity_initial: '',
      supplier_lot_ref: '',
      best_before_date: '',
      production_date: '',
      invoice_ref: '',
      notes: '',
      gs1_raw: '',
    };
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    error = e.message;
  } finally {
    saving = false;
  }
}
</script>

<ExtensionPageShell title={m['operations.traceability.reception.title']()}>
  <div class="p-6 max-w-2xl pt-0">
  {#if saved}
    <div class="alert alert-success mb-4">
      <div>
        <div class="font-bold">{m['operations.traceability.reception.success']()} <span class="font-mono">{saved.lot_number}</span></div>
        <div class="text-sm">{m['operations.traceability.reception.quarantineHint']()}</div>
        <div class="mt-2 flex gap-2">
          <a href="/admin/trace/lots/{saved.id}" class="btn btn-sm btn-success">{m['operations.traceability.reception.lotDetails']()}</a>
          <a href="/ext/operations/traceability/labels/{saved.id}" target="_blank" class="btn btn-sm btn-outline">{m['operations.traceability.reception.printLabel']()}</a>
        </div>
      </div>
    </div>
  {/if}

  {#if error}
    <div class="alert alert-error mb-4">{error}</div>
  {/if}

  <form onsubmit={submit} class="space-y-4">
    <!-- GS1 scanner input -->
    <div class="card bg-base-200 p-4">
      <h3 class="font-semibold mb-2">{m['operations.traceability.ui.scanare_gs1_op_ional']()}</h3>
      <div class="flex gap-2">
        <input
          type="text"
          class="input input-bordered flex-1"
          placeholder={m['operations.traceability.ui.scana_i_codul_gs1_128_de_pe_eticheta_furnizorulu']()}
          bind:value={form.gs1_raw}
          onchange={parseGS1}
        />
        <button type="button" class="btn btn-outline btn-sm" onclick={parseGS1}>{m['operations.traceability.ui.parseaz']()}</button>
      </div>
    </div>

    <div class="grid grid-cols-2 gap-4">
      <div class="col-span-2">
        <label class="label"><span class="label-text font-medium">{m['operations.traceability.form.product']()}</span></label>
        <select class="select select-bordered w-full" bind:value={form.item_id} required>
          <option value="">{m['operations.traceability.ui.selecta_i_produsul']()}</option>
          {#each items as item}
            <option value={item.id}>{item.name} ({item.code})</option>
          {/each}
        </select>
      </div>

      <div>
        <label class="label"><span class="label-text font-medium">{m['operations.traceability.form.quantity']()}</span></label>
        <input type="number" class="input input-bordered w-full" min="0.001" step="0.001" bind:value={form.quantity_initial} required />
      </div>

      <div>
        <label class="label"><span class="label-text font-medium">{m['operations.traceability.form.unit']()}</span></label>
        <select class="select select-bordered w-full" bind:value={form.unit}>
          {#each ['kg','g','l','ml','buc','cutie','sac','palet'] as u}
            <option value={u}>{u}</option>
          {/each}
        </select>
      </div>

      <div>
        <label class="label"><span class="label-text font-medium">{m['operations.traceability.form.supplier']()}</span></label>
        <select class="select select-bordered w-full" bind:value={form.supplier_id}>
          <option value="">—</option>
          {#each suppliers as s}
            <option value={s.id}>{s.name}</option>
          {/each}
        </select>
      </div>

      <div>
        <label class="label"><span class="label-text font-medium">{m['operations.traceability.form.supplierLot']()}</span></label>
        <input type="text" class="input input-bordered w-full" bind:value={form.supplier_lot_ref} />
      </div>

      <div>
        <label class="label"><span class="label-text font-medium">{m['operations.traceability.form.bbd']()}</span></label>
        <input type="date" class="input input-bordered w-full" bind:value={form.best_before_date} />
      </div>

      <div>
        <label class="label"><span class="label-text font-medium">{m['operations.traceability.form.receptionDate']()}</span></label>
        <input type="date" class="input input-bordered w-full" bind:value={form.reception_date} required />
      </div>

      <div>
        <label class="label"><span class="label-text font-medium">{m['operations.traceability.form.invoice']()}</span></label>
        <input type="text" class="input input-bordered w-full" bind:value={form.invoice_ref} />
      </div>

      <div>
        <label class="label"><span class="label-text font-medium">{m['operations.traceability.form.location']()}</span></label>
        <select class="select select-bordered w-full" bind:value={form.location_id}>
          <option value="">—</option>
          {#each locations as loc}
            <option value={loc.id}>{loc.warehouse}{loc.row ? ' / ' + loc.row : ''}{loc.shelf ? ' / ' + loc.shelf : ''}</option>
          {/each}
        </select>
      </div>

      <div class="col-span-2">
        <label class="label"><span class="label-text font-medium">{m['operations.traceability.form.notes']()}</span></label>
        <textarea class="textarea textarea-bordered w-full" rows="2" bind:value={form.notes}></textarea>
      </div>
    </div>

    <div class="flex justify-end gap-3">
      <a href="/admin/trace/lots" class="btn btn-ghost">{m['common.cancel']()}</a>
      <button type="submit" class="btn btn-primary" disabled={saving}>
        {saving ? m['operations.traceability.form.saving']() : m['operations.traceability.form.submit']()}
      </button>
    </div>
  </form>
  </div>
</ExtensionPageShell>
