<script lang="ts">
  import { FileText, ShoppingCart, TrendingUp } from '@lucide/svelte';

  let { data } = $props();

  // Exemplu: fetch comenzi sau documente partener (offline-first)
  // import { useCollection } from '$stores/collection.svelte';
  // const orders = useCollection('orders');
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-3xl font-bold">Welcome, {data.user?.name}</h1>
    <p class="text-base-content/60 mt-1">Partner portal overview.</p>
  </div>

  <!-- Stats -->
  <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
    <div class="stat bg-base-100 rounded-box shadow">
      <div class="stat-figure text-primary">
        <FileText size={24} />
      </div>
      <div class="stat-title">Documents</div>
      <div class="stat-value text-primary">—</div>
      <div class="stat-desc">Shared with you</div>
    </div>

    <div class="stat bg-base-100 rounded-box shadow">
      <div class="stat-figure text-secondary">
        <ShoppingCart size={24} />
      </div>
      <div class="stat-title">Orders</div>
      <div class="stat-value text-secondary">—</div>
      <div class="stat-desc">Active orders</div>
    </div>

    <div class="stat bg-base-100 rounded-box shadow">
      <div class="stat-figure text-accent">
        <TrendingUp size={24} />
      </div>
      <div class="stat-title">Performance</div>
      <div class="stat-value text-accent text-lg">—</div>
      <div class="stat-desc">This month</div>
    </div>
  </div>

  <!-- Placeholder -->
  <div class="card bg-base-100 shadow">
    <div class="card-body">
      <h2 class="card-title">Partner Portal Template</h2>
      <p class="text-base-content/60">
        Customize this dashboard with your partner-specific collections using
        <code class="badge badge-ghost">useCollection('orders')</code>.
      </p>
    </div>
  </div>
</div>
