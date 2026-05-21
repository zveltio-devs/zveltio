<script lang="ts">
  const API = '/ext/operations/traceability';

  let items = $state<any[]>([]);
  let suppliers = $state<any[]>([]);
  let locations = $state<any[]>([]);
  let saving = $state(false);
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
      fetch(`${API}/items?type=raw`).then(r => r.json()).then(d => { items = d.data ?? []; }),
      fetch(`${API}/suppliers`).then(r => r.json()).then(d => { suppliers = d.data ?? []; }),
      fetch(`${API}/locations`).then(r => r.json()).then(d => { locations = d.data ?? []; }),
    ]);
  });

  async function parseGS1() {
    if (!form.gs1_raw.trim()) return;
    try {
      const res = await fetch(`${API}/scan/parse-gs1`, {
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

      const res = await fetch(`${API}/lots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error(await res.text());
      saved = (await res.json()).data;

      // Reset form
      form = { ...form, item_id: '', quantity_initial: '', supplier_lot_ref: '', best_before_date: '', production_date: '', invoice_ref: '', notes: '', gs1_raw: '' };
    } catch (e: any) {
      error = e.message;
    } finally {
      saving = false;
    }
  }
</script>

<div class="p-6 max-w-2xl">
  <h1 class="text-2xl font-bold mb-6">Recepție materie primă</h1>

  {#if saved}
    <div class="alert alert-success mb-4">
      <div>
        <div class="font-bold">Lot creat cu succes: <span class="font-mono">{saved.lot_number}</span></div>
        <div class="text-sm">Statusul inițial: carantină. Eliberați lotul după verificare.</div>
        <div class="mt-2 flex gap-2">
          <a href="/admin/trace/lots/{saved.id}" class="btn btn-sm btn-success">Detalii lot</a>
          <a href="/ext/operations/traceability/labels/{saved.id}" target="_blank" class="btn btn-sm btn-outline">🖨 Printează etichetă</a>
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
      <h3 class="font-semibold mb-2">Scanare GS1 (opțional)</h3>
      <div class="flex gap-2">
        <input
          type="text"
          class="input input-bordered flex-1"
          placeholder="Scanați codul GS1-128 de pe eticheta furnizorului..."
          bind:value={form.gs1_raw}
          onchange={parseGS1}
        />
        <button type="button" class="btn btn-outline btn-sm" onclick={parseGS1}>Parsează</button>
      </div>
    </div>

    <div class="grid grid-cols-2 gap-4">
      <div class="col-span-2">
        <label class="label"><span class="label-text font-medium">Produs *</span></label>
        <select class="select select-bordered w-full" bind:value={form.item_id} required>
          <option value="">Selectați produsul...</option>
          {#each items as item}
            <option value={item.id}>{item.name} ({item.code})</option>
          {/each}
        </select>
      </div>

      <div>
        <label class="label"><span class="label-text font-medium">Cantitate *</span></label>
        <input type="number" class="input input-bordered w-full" min="0.001" step="0.001" bind:value={form.quantity_initial} required />
      </div>

      <div>
        <label class="label"><span class="label-text font-medium">Unitate *</span></label>
        <select class="select select-bordered w-full" bind:value={form.unit}>
          {#each ['kg','g','l','ml','buc','cutie','sac','palet'] as u}
            <option value={u}>{u}</option>
          {/each}
        </select>
      </div>

      <div>
        <label class="label"><span class="label-text font-medium">Furnizor</span></label>
        <select class="select select-bordered w-full" bind:value={form.supplier_id}>
          <option value="">—</option>
          {#each suppliers as s}
            <option value={s.id}>{s.name}</option>
          {/each}
        </select>
      </div>

      <div>
        <label class="label"><span class="label-text font-medium">Lot furnizor</span></label>
        <input type="text" class="input input-bordered w-full" bind:value={form.supplier_lot_ref} />
      </div>

      <div>
        <label class="label"><span class="label-text font-medium">Data valabilitate (BBD)</span></label>
        <input type="date" class="input input-bordered w-full" bind:value={form.best_before_date} />
      </div>

      <div>
        <label class="label"><span class="label-text font-medium">Data recepție *</span></label>
        <input type="date" class="input input-bordered w-full" bind:value={form.reception_date} required />
      </div>

      <div>
        <label class="label"><span class="label-text font-medium">Factură / Aviz</span></label>
        <input type="text" class="input input-bordered w-full" bind:value={form.invoice_ref} />
      </div>

      <div>
        <label class="label"><span class="label-text font-medium">Locație</span></label>
        <select class="select select-bordered w-full" bind:value={form.location_id}>
          <option value="">—</option>
          {#each locations as loc}
            <option value={loc.id}>{loc.warehouse}{loc.row ? ' / ' + loc.row : ''}{loc.shelf ? ' / ' + loc.shelf : ''}</option>
          {/each}
        </select>
      </div>

      <div class="col-span-2">
        <label class="label"><span class="label-text font-medium">Note</span></label>
        <textarea class="textarea textarea-bordered w-full" rows="2" bind:value={form.notes}></textarea>
      </div>
    </div>

    <div class="flex justify-end gap-3">
      <a href="/admin/trace/lots" class="btn btn-ghost">Anulează</a>
      <button type="submit" class="btn btn-primary" disabled={saving}>
        {saving ? 'Se salvează...' : 'Salvează și creează lot'}
      </button>
    </div>
  </form>
</div>
