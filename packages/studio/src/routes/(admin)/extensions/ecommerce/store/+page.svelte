<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.svelte.js';
  import { Plus, X, Trash2, LoaderCircle, ShoppingBag, ShoppingCart, Tag, BarChart2 } from '@lucide/svelte';

  type Product = {
    id: string; name: string; slug: string; price: number | null;
    currency: string; stock_qty: number; is_active: boolean;
    category_name: string | null; avg_rating: number | null;
  };
  type Order = {
    id: string; order_number: string; customer_name: string | null;
    customer_email: string; status: string; total: number; currency: string;
    created_at: string;
  };
  type Stats = { total_orders: number; total_revenue: number; total_products: number; pending_orders: number };

  let tab = $state<'products' | 'orders'>('products');
  let products = $state<Product[]>([]);
  let orders = $state<Order[]>([]);
  let stats = $state<Stats | null>(null);
  let loading = $state(false);
  let showModal = $state(false);
  let saving = $state(false);

  let productForm = $state({ name: '', slug: '', price: '', currency: 'RON', stock_qty: '0', is_active: true, short_description: '' });

  onMount(async () => {
    await Promise.all([loadProducts(), loadOrders(), loadStats()]);
  });

  async function loadProducts() {
    loading = true;
    try {
      const r = await api.get<{ data: Product[] }>('/api/ecommerce/admin/products');
      products = r.data ?? [];
    } catch (e: any) { toast.error(e?.message ?? 'Failed to load products'); }
    finally { loading = false; }
  }
  async function loadOrders() {
    try {
      const r = await api.get<{ data: Order[] }>('/api/ecommerce/admin/orders');
      orders = r.data ?? [];
    } catch { /* ignore */ }
  }
  async function loadStats() {
    try {
      const r = await api.get<{ stats: Stats }>('/api/ecommerce/admin/stats');
      stats = r.stats;
    } catch { /* ignore */ }
  }

  async function createProduct() {
    if (!productForm.name.trim()) return;
    saving = true;
    try {
      const slug = productForm.slug || productForm.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      const r = await api.post<{ data: Product }>('/api/ecommerce/admin/products', {
        ...productForm,
        slug,
        price: productForm.price ? parseFloat(productForm.price) : null,
        stock_qty: parseInt(productForm.stock_qty) || 0,
      });
      products = [r.data, ...products];
      productForm = { name: '', slug: '', price: '', currency: 'RON', stock_qty: '0', is_active: true, short_description: '' };
      showModal = false;
      toast.success('Product created.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
    finally { saving = false; }
  }

  async function deleteProduct(id: string) {
    if (!confirm('Delete this product?')) return;
    try {
      await api.delete(`/api/ecommerce/admin/products/${id}`);
      products = products.filter(p => p.id !== id);
      toast.success('Deleted.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }

  async function updateOrderStatus(id: string, status: string) {
    try {
      await api.patch(`/api/ecommerce/admin/orders/${id}`, { status });
      orders = orders.map(o => o.id === id ? { ...o, status } : o);
      toast.success('Order updated.');
    } catch (e: any) { toast.error(e?.message ?? 'Error'); }
  }

  const orderStatusColor: Record<string, string> = {
    pending: 'badge-warning', processing: 'badge-info', shipped: 'badge-primary',
    delivered: 'badge-success', cancelled: 'badge-error',
  };
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold">eCommerce</h1>
      <p class="text-sm text-base-content/50">Products, orders, and store management</p>
    </div>
    {#if tab === 'products'}
      <button class="btn btn-primary btn-sm gap-1" onclick={() => (showModal = true)}>
        <Plus size={14} /> New Product
      </button>
    {/if}
  </div>

  <!-- Stats -->
  {#if stats}
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <div class="stat bg-base-200 rounded-xl py-3">
        <div class="stat-title text-xs">Total Orders</div>
        <div class="stat-value text-lg">{stats.total_orders}</div>
      </div>
      <div class="stat bg-base-200 rounded-xl py-3">
        <div class="stat-title text-xs">Revenue</div>
        <div class="stat-value text-lg">{stats.total_revenue.toLocaleString()}</div>
      </div>
      <div class="stat bg-base-200 rounded-xl py-3">
        <div class="stat-title text-xs">Products</div>
        <div class="stat-value text-lg">{stats.total_products}</div>
      </div>
      <div class="stat bg-base-200 rounded-xl py-3">
        <div class="stat-title text-xs">Pending</div>
        <div class="stat-value text-lg text-warning">{stats.pending_orders}</div>
      </div>
    </div>
  {/if}

  <div class="tabs tabs-boxed bg-base-200 w-fit">
    <button class="tab {tab === 'products' ? 'tab-active' : ''}" onclick={() => (tab = 'products')}>
      <Tag size={13} class="mr-1.5" /> Products
    </button>
    <button class="tab {tab === 'orders' ? 'tab-active' : ''}" onclick={() => (tab = 'orders')}>
      <ShoppingCart size={13} class="mr-1.5" /> Orders
    </button>
  </div>

  {#if loading}
    <div class="flex justify-center py-16"><LoaderCircle size={28} class="animate-spin text-primary" /></div>
  {:else if tab === 'products'}
    {#if products.length === 0}
      <div class="card bg-base-200"><div class="card-body items-center py-16 text-base-content/40 text-sm">No products yet</div></div>
    {:else}
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead><tr><th>Name</th><th>Category</th><th>Price</th><th>Stock</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {#each products as p (p.id)}
              <tr class="hover">
                <td class="font-medium">{p.name}</td>
                <td class="text-base-content/60">{p.category_name ?? '—'}</td>
                <td>{p.price != null ? `${p.price.toLocaleString()} ${p.currency}` : '—'}</td>
                <td class="{p.stock_qty === 0 ? 'text-error' : 'text-base-content/70'}">{p.stock_qty}</td>
                <td><span class="badge badge-xs {p.is_active ? 'badge-success' : 'badge-ghost'}">{p.is_active ? 'Active' : 'Inactive'}</span></td>
                <td>
                  <button class="btn btn-ghost btn-xs text-error" onclick={() => deleteProduct(p.id)}><Trash2 size={12} /></button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {:else}
    {#if orders.length === 0}
      <div class="card bg-base-200"><div class="card-body items-center py-16 text-base-content/40 text-sm">No orders yet</div></div>
    {:else}
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead><tr><th>Order #</th><th>Customer</th><th>Total</th><th>Status</th><th>Date</th><th>Actions</th></tr></thead>
          <tbody>
            {#each orders as o (o.id)}
              <tr class="hover">
                <td class="font-mono text-xs">{o.order_number}</td>
                <td>
                  <div class="text-sm">{o.customer_name ?? '—'}</div>
                  <div class="text-xs text-base-content/50">{o.customer_email}</div>
                </td>
                <td class="font-medium">{o.total.toLocaleString()} {o.currency}</td>
                <td><span class="badge badge-sm {orderStatusColor[o.status] ?? 'badge-ghost'}">{o.status}</span></td>
                <td class="text-xs text-base-content/40">{new Date(o.created_at).toLocaleDateString()}</td>
                <td>
                  <select class="select select-xs" value={o.status}
                    onchange={(e) => updateOrderStatus(o.id, (e.target as HTMLSelectElement).value)}>
                    <option value="pending">Pending</option>
                    <option value="processing">Processing</option>
                    <option value="shipped">Shipped</option>
                    <option value="delivered">Delivered</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</div>

{#if showModal}
  <div class="modal modal-open">
    <div class="modal-box max-w-md">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold">New Product</h3>
        <button class="btn btn-ghost btn-xs" onclick={() => (showModal = false)}><X size={14} /></button>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div class="form-control col-span-2"><label class="label py-0"><span class="label-text text-xs">Name *</span></label>
          <input class="input input-sm" bind:value={productForm.name} /></div>
        <div class="form-control col-span-2"><label class="label py-0"><span class="label-text text-xs">Short Description</span></label>
          <input class="input input-sm" bind:value={productForm.short_description} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Price</span></label>
          <input class="input input-sm" type="number" bind:value={productForm.price} /></div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Currency</span></label>
          <select class="select select-sm" bind:value={productForm.currency}>
            <option>RON</option><option>EUR</option><option>USD</option>
          </select>
        </div>
        <div class="form-control"><label class="label py-0"><span class="label-text text-xs">Stock Qty</span></label>
          <input class="input input-sm" type="number" bind:value={productForm.stock_qty} /></div>
        <div class="form-control justify-end">
          <label class="flex items-center gap-2 cursor-pointer py-2">
            <input type="checkbox" class="checkbox checkbox-sm" bind:checked={productForm.is_active} />
            <span class="text-sm">Active</span>
          </label>
        </div>
      </div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" onclick={() => (showModal = false)}>Cancel</button>
        <button class="btn btn-primary btn-sm" onclick={createProduct} disabled={!productForm.name.trim() || saving}>
          {#if saving}<LoaderCircle size={13} class="animate-spin mr-1" />{/if}Create
        </button>
      </div>
    </div>
  </div>
{/if}
