<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { m } from '$lib/i18n.svelte.js';
  import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
  import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
  import { Boxes, Plus, X, Warehouse, Package, LoaderCircle } from '@lucide/svelte';

  type TabId = 'products' | 'warehouses' | 'stock';

  let tab = $state<TabId>('products');
  let products = $state<{ id: string; sku: string; name: string; price: number; currency: string; tax_rate: number; is_active: boolean }[]>([]);
  let warehouses = $state<{ id: string; code: string; name: string; address?: string | null }[]>([]);
  let stock = $state<{ id: string; product_name?: string; product_id: string; warehouse_name?: string; warehouse_id: string; quantity: number }[]>([]);
  let loading = $state(true);
  let search = $state('');
  let showProductForm = $state(false);
  let showWarehouseForm = $state(false);
  let saving = $state(false);
  let productForm = $state({ sku: '', name: '', description: '', price: 0, currency: 'RON', tax_rate: 19, is_active: true });
  let warehouseForm = $state({ name: '', code: '', address: '' });

  const dash = $derived(m['common.emptyDash']());
  const yesMark = '✓';

  const tabs = $derived([
    { id: 'products' as const, label: m['inventory.tab.products'](), icon: Package },
    { id: 'warehouses' as const, label: m['inventory.tab.warehouses'](), icon: Warehouse },
    { id: 'stock' as const, label: m['inventory.tab.stock'](), icon: Boxes },
  ]);

  const emptyCopy = $derived(
    tab === 'products' ? m['inventory.empty.products']()
      : tab === 'warehouses' ? m['inventory.empty.warehouses']()
        : m['inventory.empty.stock'](),
  );

  async function loadProducts() {
    const params = new URLSearchParams();
    if (search.trim()) params.set('q', search.trim());
    const res = await api.get<{ data: typeof products }>(`/ext/operations/inventory/products?${params}`);
    products = res.data ?? [];
  }

  async function loadWarehouses() {
    const res = await api.get<{ data: typeof warehouses }>('/ext/operations/inventory/warehouses');
    warehouses = res.data ?? [];
  }

  async function loadStock() {
    const res = await api.get<{ data: typeof stock }>('/ext/operations/inventory/stock-levels');
    stock = res.data ?? [];
  }

  async function loadTab() {
    loading = true;
    try {
      if (tab === 'products') await loadProducts();
      else if (tab === 'warehouses') await loadWarehouses();
      else await loadStock();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : m['ext.loadFailed']());
    } finally {
      loading = false;
    }
  }

  async function createProduct() {
    saving = true;
    try {
      await api.post('/ext/operations/inventory/products', productForm);
      showProductForm = false;
      productForm = { sku: '', name: '', description: '', price: 0, currency: 'RON', tax_rate: 19, is_active: true };
      await loadProducts();
      toast.success(m['inventory.toast.productCreated']());
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
    } finally {
      saving = false;
    }
  }

  async function createWarehouse() {
    saving = true;
    try {
      await api.post('/ext/operations/inventory/warehouses', warehouseForm);
      showWarehouseForm = false;
      warehouseForm = { name: '', code: '', address: '' };
      await loadWarehouses();
      toast.success(m['inventory.toast.warehouseCreated']());
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
    } finally {
      saving = false;
    }
  }

  $effect(() => { tab; loadTab(); });

  onMount(() => {
    loadProducts();
    loadWarehouses();
  });

  function fmt(n: number, c = 'RON') {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: c }).format(n);
  }
</script>

<ExtensionPageShell
  title={m['inventory.title']()}
  subtitle={m['inventory.subtitle']()}
  {tabs}
  activeTab={tab}
  onTabChange={(id) => (tab = id as TabId)}
  search={tab === 'products' ? search : undefined}
  onSearchChange={tab === 'products' ? (v) => { search = v; loadTab(); } : undefined}
  searchPlaceholder={m['inventory.searchPlaceholder']()}
>
  {#snippet actions()}
    {#if tab === 'products'}
      <button type="button" class="btn btn-primary btn-sm gap-1" onclick={() => (showProductForm = true)}>
        <Plus size={14} aria-hidden="true" />
        {m['inventory.new.product']()}
      </button>
    {:else if tab === 'warehouses'}
      <button type="button" class="btn btn-primary btn-sm gap-1" onclick={() => (showWarehouseForm = true)}>
        <Plus size={14} aria-hidden="true" />
        {m['inventory.new.warehouse']()}
      </button>
    {/if}
  {/snippet}

  {#snippet children()}
    <ExtensionDataPanel {loading} empty={!loading && (
      tab === 'products' ? products.length === 0
        : tab === 'warehouses' ? warehouses.length === 0
          : stock.length === 0
    )} emptyTitle={emptyCopy}>
      {#snippet table()}
        {#if tab === 'products'}
          <table class="table table-sm">
            <thead>
              <tr>
                <th>{m['inventory.col.sku']()}</th>
                <th>{m['inventory.col.name']()}</th>
                <th class="text-right">{m['inventory.col.price']()}</th>
                <th>{m['inventory.col.vat']()}</th>
                <th>{m['inventory.col.active']()}</th>
              </tr>
            </thead>
            <tbody>
              {#each products as p (p.id)}
                <tr class="hover">
                  <td class="font-mono text-xs">{p.sku}</td>
                  <td class="text-sm">{p.name}</td>
                  <td class="text-right text-sm">{fmt(Number(p.price), p.currency)}</td>
                  <td class="text-sm">{p.tax_rate}%</td>
                  <td>{p.is_active ? yesMark : dash}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else if tab === 'warehouses'}
          <table class="table table-sm">
            <thead>
              <tr>
                <th>{m['inventory.col.code']()}</th>
                <th>{m['inventory.col.name']()}</th>
                <th>{m['inventory.col.address']()}</th>
              </tr>
            </thead>
            <tbody>
              {#each warehouses as w (w.id)}
                <tr class="hover">
                  <td class="font-mono text-sm">{w.code}</td>
                  <td class="text-sm">{w.name}</td>
                  <td class="text-sm">{w.address ?? dash}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else}
          <table class="table table-sm">
            <thead>
              <tr>
                <th>{m['inventory.col.product']()}</th>
                <th>{m['inventory.col.warehouse']()}</th>
                <th class="text-right">{m['inventory.col.quantity']()}</th>
              </tr>
            </thead>
            <tbody>
              {#each stock as s (s.id)}
                <tr class="hover">
                  <td class="text-sm">{s.product_name ?? s.product_id}</td>
                  <td class="text-sm">{s.warehouse_name ?? s.warehouse_id}</td>
                  <td class="text-right font-medium text-sm {Number(s.quantity) <= 0 ? 'text-error' : ''}">{s.quantity}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      {/snippet}
    </ExtensionDataPanel>
  {/snippet}
</ExtensionPageShell>

{#if showProductForm}
  <div class="modal modal-open">
    <div class="modal-box max-w-md">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">{m['inventory.form.newProduct']()}</h3>
        <button type="button" class="btn btn-ghost btn-xs" onclick={() => (showProductForm = false)}><X size={14} /></button>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['inventory.form.sku']()}</span></label>
          <input class="input input-sm" bind:value={productForm.sku} />
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['crm.form.currency']()}</span></label>
          <input class="input input-sm" bind:value={productForm.currency} maxlength={3} />
        </div>
        <div class="form-control col-span-2">
          <label class="label py-0"><span class="label-text text-xs">{m['inventory.col.name']()} *</span></label>
          <input class="input input-sm" bind:value={productForm.name} />
        </div>
        <div class="form-control col-span-2">
          <label class="label py-0"><span class="label-text text-xs">{m['inventory.form.description']()}</span></label>
          <textarea class="textarea textarea-sm" bind:value={productForm.description}></textarea>
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['inventory.form.price']()}</span></label>
          <input type="number" step="0.01" class="input input-sm" bind:value={productForm.price} />
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['inventory.form.vat']()}</span></label>
          <input type="number" class="input input-sm" bind:value={productForm.tax_rate} />
        </div>
      </div>
      <div class="modal-action">
        <button type="button" class="btn btn-ghost btn-sm" onclick={() => (showProductForm = false)}>{m['common.cancel']()}</button>
        <button type="button" class="btn btn-primary btn-sm" disabled={saving || !productForm.sku || !productForm.name} onclick={createProduct}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if}
          {m['common.create']()}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if showWarehouseForm}
  <div class="modal modal-open">
    <div class="modal-box max-w-sm">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">{m['inventory.form.newWarehouse']()}</h3>
        <button type="button" class="btn btn-ghost btn-xs" onclick={() => (showWarehouseForm = false)}><X size={14} /></button>
      </div>
      <div class="space-y-3">
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['inventory.col.code']()}</span></label>
          <input class="input input-sm" bind:value={warehouseForm.code} />
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['inventory.col.name']()}</span></label>
          <input class="input input-sm" bind:value={warehouseForm.name} />
        </div>
        <div class="form-control">
          <label class="label py-0"><span class="label-text text-xs">{m['inventory.col.address']()}</span></label>
          <input class="input input-sm" bind:value={warehouseForm.address} />
        </div>
      </div>
      <div class="modal-action">
        <button type="button" class="btn btn-ghost btn-sm" onclick={() => (showWarehouseForm = false)}>{m['common.cancel']()}</button>
        <button type="button" class="btn btn-primary btn-sm" disabled={saving || !warehouseForm.code || !warehouseForm.name} onclick={createWarehouse}>
          {#if saving}<LoaderCircle size={13} class="animate-spin" />{/if}
          {m['common.create']()}
        </button>
      </div>
    </div>
  </div>
{/if}
