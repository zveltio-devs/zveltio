<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { Boxes, Plus, X, Warehouse, Package, Search, LoaderCircle } from '@lucide/svelte';

  let tab = $state<'products' | 'warehouses' | 'stock'>('products');
  let products = $state<any[]>([]);
  let warehouses = $state<any[]>([]);
  let stock = $state<any[]>([]);
  let loading = $state(true);
  let q = $state('');
  let showProductForm = $state(false);
  let showWarehouseForm = $state(false);
  let saving = $state(false);
  let productForm = $state({ sku: '', name: '', description: '', price: 0, currency: 'RON', tax_rate: 19, is_active: true });
  let warehouseForm = $state({ name: '', code: '', address: '' });

  async function loadProducts() {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    const res = await api.get<{ data: any[] }>(`/ext/operations/inventory/products?${params}`);
    products = res.data ?? [];
  }
  async function loadWarehouses() {
    const res = await api.get<{ data: any[] }>('/ext/operations/inventory/warehouses');
    warehouses = res.data ?? [];
  }
  async function loadStock() {
    const res = await api.get<{ data: any[] }>('/ext/operations/inventory/stock-levels');
    stock = res.data ?? [];
  }

  async function loadTab() {
    loading = true;
    try {
      if (tab === 'products') await loadProducts();
      else if (tab === 'warehouses') await loadWarehouses();
      else await loadStock();
    } catch (e: any) { toast.error(e?.message ?? 'Failed to load'); }
    finally { loading = false; }
  }

  async function createProduct() {
    saving = true;
    try {
      await api.post('/ext/operations/inventory/products', productForm);
      showProductForm = false;
      productForm = { sku: '', name: '', description: '', price: 0, currency: 'RON', tax_rate: 19, is_active: true };
      await loadProducts();
      toast.success('Product created.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { saving = false; }
  }

  async function createWarehouse() {
    saving = true;
    try {
      await api.post('/ext/operations/inventory/warehouses', warehouseForm);
      showWarehouseForm = false;
      warehouseForm = { name: '', code: '', address: '' };
      await loadWarehouses();
      toast.success('Warehouse created.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { saving = false; }
  }

  $effect(() => { tab; loadTab(); });
  onMount(() => { loadProducts(); loadWarehouses(); });

  function fmt(n: number, c = 'RON') { return new Intl.NumberFormat('ro-RO', { style: 'currency', currency: c }).format(n); }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold flex items-center gap-2"><Boxes size={20} /> Inventory</h1>
      <p class="text-sm text-base-content/50">Products, warehouses, and stock levels</p>
    </div>
    <div>
      {#if tab === 'products'}<button class="btn btn-primary btn-sm gap-1" onclick={() => (showProductForm = true)}><Plus size={14} /> New product</button>{/if}
      {#if tab === 'warehouses'}<button class="btn btn-primary btn-sm gap-1" onclick={() => (showWarehouseForm = true)}><Plus size={14} /> New warehouse</button>{/if}
    </div>
  </div>

  <div class="tabs tabs-boxed bg-base-200 w-fit">
    <button class="tab {tab === 'products' ? 'tab-active' : ''}" onclick={() => (tab = 'products')}><Package size={13} class="mr-1.5" /> Products</button>
    <button class="tab {tab === 'warehouses' ? 'tab-active' : ''}" onclick={() => (tab = 'warehouses')}><Warehouse size={13} class="mr-1.5" /> Warehouses</button>
    <button class="tab {tab === 'stock' ? 'tab-active' : ''}" onclick={() => (tab = 'stock')}><Boxes size={13} class="mr-1.5" /> Stock levels</button>
  </div>

  {#if tab === 'products'}
    <div class="join">
      <input class="input input-sm join-item" placeholder="Search SKU / name…" bind:value={q}
             onkeydown={(e: any) => e.key === 'Enter' && loadTab()} />
      <button class="btn btn-sm join-item" onclick={loadTab}><Search size={14} /></button>
    </div>
  {/if}

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if tab === 'products'}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>SKU</th><th>Name</th><th class="text-right">Price</th><th>VAT %</th><th>Active</th></tr></thead>
        <tbody>
          {#if products.length === 0}<tr><td colspan="5" class="text-center py-6 text-base-content/50 text-sm">No products.</td></tr>
          {:else}{#each products as p (p.id)}<tr class="hover"><td class="font-mono text-xs">{p.sku}</td><td class="text-sm">{p.name}</td><td class="text-right text-sm">{fmt(Number(p.price), p.currency)}</td><td class="text-sm">{p.tax_rate}%</td><td>{p.is_active ? '✓' : '—'}</td></tr>{/each}{/if}
        </tbody>
      </table>
    </div>
  {:else if tab === 'warehouses'}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>Code</th><th>Name</th><th>Address</th></tr></thead>
        <tbody>
          {#if warehouses.length === 0}<tr><td colspan="3" class="text-center py-6 text-base-content/50 text-sm">No warehouses.</td></tr>
          {:else}{#each warehouses as w (w.id)}<tr class="hover"><td class="font-mono text-sm">{w.code}</td><td class="text-sm">{w.name}</td><td class="text-sm">{w.address ?? '—'}</td></tr>{/each}{/if}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead><tr><th>Product</th><th>Warehouse</th><th class="text-right">Quantity</th></tr></thead>
        <tbody>
          {#if stock.length === 0}<tr><td colspan="3" class="text-center py-6 text-base-content/50 text-sm">No stock data.</td></tr>
          {:else}{#each stock as s (s.id)}<tr class="hover"><td class="text-sm">{s.product_name ?? s.product_id}</td><td class="text-sm">{s.warehouse_name ?? s.warehouse_id}</td><td class="text-right font-medium text-sm {Number(s.quantity) <= 0 ? 'text-error' : ''}">{s.quantity}</td></tr>{/each}{/if}
        </tbody>
      </table>
    </div>
  {/if}
</div>

{#if showProductForm}
  <div class="modal modal-open">
    <div class="modal-box max-w-md">
      <div class="flex items-center justify-between mb-4"><h3 class="font-semibold">New product</h3><button class="btn btn-ghost btn-xs" onclick={() => (showProductForm = false)}><X size={14} /></button></div>
      <div class="grid grid-cols-2 gap-3">
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">SKU</span></label><input class="input input-sm" bind:value={productForm.sku} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Currency</span></label><input class="input input-sm" bind:value={productForm.currency} maxlength={3} /></div>
        <div class="form-control col-span-2"><label class="label py-0"><span class="label-text text-xs">Name *</span></label><input class="input input-sm" bind:value={productForm.name} /></div>
        <div class="form-control col-span-2"><label class="label py-0"><span class="label-text text-xs">Description</span></label><textarea class="textarea textarea-sm" bind:value={productForm.description}></textarea></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Price</span></label><input type="number" step="0.01" class="input input-sm" bind:value={productForm.price} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">VAT %</span></label><input type="number" class="input input-sm" bind:value={productForm.tax_rate} /></div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showProductForm = false)}>Cancel</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !productForm.sku || !productForm.name} onclick={createProduct}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if} Create
        </button>
      </div>
    </div>
  </div>
{/if}

{#if showWarehouseForm}
  <div class="modal modal-open">
    <div class="modal-box max-w-sm">
      <div class="flex items-center justify-between mb-4"><h3 class="font-semibold">New warehouse</h3><button class="btn btn-ghost btn-xs" onclick={() => (showWarehouseForm = false)}><X size={14} /></button></div>
      <div class="space-y-3">
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Code</span></label><input class="input input-sm" bind:value={warehouseForm.code} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Name</span></label><input class="input input-sm" bind:value={warehouseForm.name} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Address</span></label><input class="input input-sm" bind:value={warehouseForm.address} /></div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showWarehouseForm = false)}>Cancel</button>
        <button class="btn btn-primary btn-sm" disabled={saving || !warehouseForm.code || !warehouseForm.name} onclick={createWarehouse}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if} Create
        </button>
      </div>
    </div>
  </div>
{/if}
