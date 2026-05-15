<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { Plus, CheckCircle, Package, Users, BarChart3, LoaderCircle } from '@lucide/svelte';

  let activeTab = $state<'orders' | 'suppliers' | 'budget'>('orders');
  let orders = $state<any[]>([]);
  let suppliers = $state<any[]>([]);
  let budgetLines = $state<any[]>([]);
  let loading = $state(true);

  let showOrderModal = $state(false);
  let showSupplierModal = $state(false);
  let creating = $state(false);

  let orderForm = $state({
    number: '',
    date: new Date().toISOString().split('T')[0],
    supplier_name: '',
    supplier_cui: '',
    description: '',
    currency: 'RON',
    subtotal: 0,
    vat_total: 0,
    total: 0,
    items: [{ description: '', quantity: 1, unit: 'BUC', unit_price: 0, total: 0 }],
  });

  let supplierForm = $state({ name: '', cui: '', county: '', category: '', contact_email: '' });

  onMount(loadAll);

  async function loadAll() {
    loading = true;
    try {
      const [ord, sup, bud] = await Promise.all([
        api.get<{ orders: any[] }>('/ext/compliance/ro/procurement/orders'),
        api.get<{ suppliers: any[] }>('/ext/compliance/ro/procurement/suppliers'),
        api.get<{ budget_lines: any[] }>(`/ext/compliance/ro/procurement/budget?year=${new Date().getFullYear()}`),
      ]);
      orders = ord.orders ?? [];
      suppliers = sup.suppliers ?? [];
      budgetLines = bud.budget_lines ?? [];
    } catch (e: any) { toast.error(e?.message ?? 'Failed to load'); }
    finally { loading = false; }
  }

  function recalcItem(item: any) {
    item.total = Math.round(item.quantity * item.unit_price * 100) / 100;
    orderForm.subtotal = orderForm.items.reduce((s, i) => s + i.total, 0);
    orderForm.vat_total = Math.round(orderForm.subtotal * 0.19 * 100) / 100;
    orderForm.total = orderForm.subtotal + orderForm.vat_total;
  }

  async function createOrder() {
    if (!orderForm.number || !orderForm.supplier_name) return;
    creating = true;
    try {
      await api.post('/ext/compliance/ro/procurement/orders', orderForm);
      showOrderModal = false;
      await loadAll();
      toast.success('Comanda creata.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { creating = false; }
  }

  async function createSupplier() {
    if (!supplierForm.name || !supplierForm.cui) return;
    creating = true;
    try {
      await api.post('/ext/compliance/ro/procurement/suppliers', supplierForm);
      showSupplierModal = false;
      supplierForm = { name: '', cui: '', county: '', category: '', contact_email: '' };
      await loadAll();
      toast.success('Furnizor inregistrat.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { creating = false; }
  }

  async function approveOrder(id: string) {
    try { await api.post(`/ext/compliance/ro/procurement/orders/${id}/approve`, {}); await loadAll(); }
    catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }

  async function receiveOrder(id: string) {
    try { await api.post(`/ext/compliance/ro/procurement/orders/${id}/receive`, {}); await loadAll(); }
    catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }

  function statusBadge(status: string): string {
    return ({ draft: 'badge-warning', approved: 'badge-info', received: 'badge-success', cancelled: 'badge-error' } as Record<string, string>)[status] ?? 'badge-ghost';
  }

  function budgetPercent(line: any): number {
    if (!line.allocated || line.allocated === 0) return 0;
    return Math.min(100, Math.round((line.spent / line.allocated) * 100));
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold">Achizitii Publice RO</h1>
      <p class="text-sm text-base-content/50">Comenzi de achizitie, furnizori, executie bugetara</p>
    </div>
    {#if activeTab === 'orders'}
      <button class="btn btn-primary btn-sm gap-1" onclick={() => (showOrderModal = true)}><Plus size={14} /> Comanda noua</button>
    {:else if activeTab === 'suppliers'}
      <button class="btn btn-primary btn-sm gap-1" onclick={() => (showSupplierModal = true)}><Plus size={14} /> Furnizor nou</button>
    {/if}
  </div>

  <div class="tabs tabs-boxed bg-base-200 w-fit">
    <button class="tab gap-2 {activeTab === 'orders' ? 'tab-active' : ''}" onclick={() => (activeTab = 'orders')}>
      <Package size={14} /> Comenzi
    </button>
    <button class="tab gap-2 {activeTab === 'suppliers' ? 'tab-active' : ''}" onclick={() => (activeTab = 'suppliers')}>
      <Users size={14} /> Furnizori
    </button>
    <button class="tab gap-2 {activeTab === 'budget' ? 'tab-active' : ''}" onclick={() => (activeTab = 'budget')}>
      <BarChart3 size={14} /> Buget
    </button>
  </div>

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if activeTab === 'orders'}
    {#if orders.length === 0}
      <div class="card bg-base-200"><div class="card-body items-center py-12 text-base-content/50 text-sm">Nu există comenzi de achizitie.</div></div>
    {:else}
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead><tr><th>Număr</th><th>Data</th><th>Furnizor</th><th>Descriere</th><th>Total</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {#each orders as o (o.id)}
              <tr class="hover">
                <td class="font-mono text-sm">{o.number}</td>
                <td class="text-sm">{o.date}</td>
                <td class="text-sm">{o.supplier_name}</td>
                <td class="text-sm max-w-48 truncate">{o.description}</td>
                <td class="font-mono text-sm">{Number(o.total).toFixed(2)} {o.currency}</td>
                <td><span class="badge badge-sm {statusBadge(o.status)}">{o.status}</span></td>
                <td>
                  {#if o.status === 'draft'}
                    <button class="btn btn-ghost btn-xs" onclick={() => approveOrder(o.id)}>Aprobare</button>
                  {:else if o.status === 'approved'}
                    <button class="btn btn-ghost btn-xs gap-1" onclick={() => receiveOrder(o.id)}>
                      <CheckCircle size={12} /> Receptie
                    </button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

  {:else if activeTab === 'suppliers'}
    {#if suppliers.length === 0}
      <div class="card bg-base-200"><div class="card-body items-center py-12 text-base-content/50 text-sm">Nu există furnizori inregistrati.</div></div>
    {:else}
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        {#each suppliers as s (s.id)}
          <div class="card bg-base-200 border border-base-300">
            <div class="card-body p-3">
              <h3 class="font-semibold text-sm">{s.name}</h3>
              <p class="text-sm font-mono text-base-content/60">CUI: {s.cui}</p>
              {#if s.county}<p class="text-xs text-base-content/40">{s.county}</p>{/if}
              {#if s.category}<span class="badge badge-outline badge-xs">{s.category}</span>{/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}

  {:else}
    {#if budgetLines.length === 0}
      <div class="card bg-base-200"><div class="card-body items-center py-12 text-base-content/50 text-sm">Nu există linii bugetare.</div></div>
    {:else}
      <div class="space-y-3">
        {#each budgetLines as line (line.id)}
          <div class="card bg-base-200 border border-base-300">
            <div class="card-body p-3">
              <div class="flex items-start justify-between">
                <div>
                  <div class="flex items-center gap-2">
                    <span class="font-mono text-sm font-bold">{line.code}</span>
                    <span class="text-sm">{line.name}</span>
                  </div>
                  <div class="flex gap-4 mt-1 text-xs text-base-content/60">
                    <span>Alocat: <strong class="font-mono">{Number(line.allocated).toFixed(2)}</strong></span>
                    <span>Cheltuit: <strong class="font-mono text-warning">{Number(line.spent).toFixed(2)}</strong></span>
                    <span>Ramas: <strong class="font-mono text-success">{Number(line.remaining).toFixed(2)}</strong> {line.currency}</span>
                  </div>
                </div>
                <span class="text-sm font-mono">{budgetPercent(line)}%</span>
              </div>
              <progress
                class="progress {budgetPercent(line) > 90 ? 'progress-error' : budgetPercent(line) > 70 ? 'progress-warning' : 'progress-primary'} mt-2"
                value={budgetPercent(line)} max="100"
              ></progress>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

{#if showOrderModal}
  <dialog class="modal modal-open">
    <div class="modal-box w-11/12 max-w-3xl">
      <h3 class="font-bold text-lg mb-4">Comanda noua de achizitie</h3>
      <div class="grid grid-cols-2 gap-3 mb-4">
        <div class="form-control">
          <label class="label" for="order-number"><span class="label-text">Număr comanda</span></label>
          <input id="order-number" type="text" bind:value={orderForm.number} placeholder="CA-2026-001" class="input input-sm font-mono" />
        </div>
        <div class="form-control">
          <label class="label" for="order-date"><span class="label-text">Data</span></label>
          <input id="order-date" type="date" bind:value={orderForm.date} class="input input-sm" />
        </div>
        <div class="form-control">
          <label class="label" for="order-supplier"><span class="label-text">Furnizor</span></label>
          <input id="order-supplier" type="text" bind:value={orderForm.supplier_name} class="input input-sm" />
        </div>
        <div class="form-control">
          <label class="label" for="order-supplier-cui"><span class="label-text">CUI Furnizor</span></label>
          <input id="order-supplier-cui" type="text" bind:value={orderForm.supplier_cui} class="input input-sm font-mono" />
        </div>
        <div class="form-control col-span-2">
          <label class="label" for="order-description"><span class="label-text">Descriere obiect achizitie</span></label>
          <input id="order-description" type="text" bind:value={orderForm.description} class="input input-sm" />
        </div>
      </div>

      <div class="overflow-x-auto mb-4">
        <table class="table table-xs">
          <thead><tr><th>Articol</th><th>Cant.</th><th>UM</th><th>Pret unitar</th><th>Total</th></tr></thead>
          <tbody>
            {#each orderForm.items as item}
              <tr>
                <td><input type="text" bind:value={item.description} class="input input-xs w-36" /></td>
                <td><input type="number" bind:value={item.quantity} oninput={() => recalcItem(item)} class="input input-xs w-16" /></td>
                <td><input type="text" bind:value={item.unit} class="input input-xs w-12" /></td>
                <td><input type="number" step="0.01" bind:value={item.unit_price} oninput={() => recalcItem(item)} class="input input-xs w-24" /></td>
                <td class="font-mono text-xs">{item.total.toFixed(2)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
        <button class="btn btn-ghost btn-xs mt-1" onclick={() => (orderForm.items = [...orderForm.items, { description: '', quantity: 1, unit: 'BUC', unit_price: 0, total: 0 }])}>+ Linie</button>
      </div>

      <div class="text-right text-sm">
        <p>Subtotal: <strong class="font-mono">{orderForm.subtotal.toFixed(2)} RON</strong></p>
        <p>TVA 19%: <strong class="font-mono">{orderForm.vat_total.toFixed(2)} RON</strong></p>
        <p class="text-base font-bold">Total: <strong class="font-mono">{orderForm.total.toFixed(2)} RON</strong></p>
      </div>

      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => (showOrderModal = false)}>Anulare</button>
        <button class="btn btn-primary" onclick={createOrder} disabled={creating || !orderForm.number || !orderForm.supplier_name}>
          {#if creating}<span class="loading loading-spinner loading-sm"></span>{/if} Creare comanda
        </button>
      </div>
    </div>
    <button class="modal-backdrop" onclick={() => (showOrderModal = false)}></button>
  </dialog>
{/if}

{#if showSupplierModal}
  <dialog class="modal modal-open">
    <div class="modal-box">
      <h3 class="font-bold text-lg mb-4">Furnizor nou</h3>
      <div class="space-y-3">
        <div class="form-control">
          <label class="label" for="supplier-name"><span class="label-text">Denumire</span></label>
          <input id="supplier-name" type="text" bind:value={supplierForm.name} class="input input-sm" />
        </div>
        <div class="form-control">
          <label class="label" for="supplier-cui"><span class="label-text">CUI</span></label>
          <input id="supplier-cui" type="text" bind:value={supplierForm.cui} class="input input-sm font-mono" />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control">
            <label class="label" for="supplier-county"><span class="label-text">Judet</span></label>
            <input id="supplier-county" type="text" bind:value={supplierForm.county} class="input input-sm" />
          </div>
          <div class="form-control">
            <label class="label" for="supplier-category"><span class="label-text">Categorie</span></label>
            <input id="supplier-category" type="text" bind:value={supplierForm.category} class="input input-sm" />
          </div>
        </div>
        <div class="form-control">
          <label class="label" for="supplier-email"><span class="label-text">Email contact</span></label>
          <input id="supplier-email" type="email" bind:value={supplierForm.contact_email} class="input input-sm" />
        </div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost" onclick={() => (showSupplierModal = false)}>Anulare</button>
        <button class="btn btn-primary" onclick={createSupplier} disabled={creating || !supplierForm.name || !supplierForm.cui}>
          {#if creating}<span class="loading loading-spinner loading-sm"></span>{/if} Inregistrare
        </button>
      </div>
    </div>
    <button class="modal-backdrop" onclick={() => (showSupplierModal = false)}></button>
  </dialog>
{/if}
