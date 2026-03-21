<script lang="ts">
  import { Activity, Database, Clock } from '@lucide/svelte';

  let { data } = $props();

  // Exemplu: fetch o colectie de tasks (offline-first)
  // Developerii care folosesc template-ul inlocuiesc cu colectiile lor
  // import { useCollection } from '$stores/collection.svelte';
  // const tasks = useCollection('tasks');

  // Code example — avoid literal <script> tags to prevent Svelte parser confusion
  const s = "<" + "script>";
  const se = "<" + "/script>";
  const codeExample = [
    s,
    "  import { useCollection } from '$stores/collection.svelte';",
    "  const products = useCollection('products');",
    se,
    "",
    "{#each products.data as product}",
    "  <div>{product.name} — {product._syncStatus}</div>",
    "{/each}",
  ].join("\n");
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-3xl font-bold">Welcome, {data.user?.name}</h1>
    <p class="text-base-content/60 mt-1">Here's your dashboard overview.</p>
  </div>

  <!-- Stats -->
  <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
    <div class="stat bg-base-100 rounded-box shadow">
      <div class="stat-figure text-primary">
        <Database size={24} />
      </div>
      <div class="stat-title">Collections</div>
      <div class="stat-value text-primary">—</div>
      <div class="stat-desc">Connect your data</div>
    </div>

    <div class="stat bg-base-100 rounded-box shadow">
      <div class="stat-figure text-secondary">
        <Activity size={24} />
      </div>
      <div class="stat-title">Activity</div>
      <div class="stat-value text-secondary">—</div>
      <div class="stat-desc">This week</div>
    </div>

    <div class="stat bg-base-100 rounded-box shadow">
      <div class="stat-figure text-accent">
        <Clock size={24} />
      </div>
      <div class="stat-title">Last Sync</div>
      <div class="stat-value text-accent text-lg">Now</div>
      <div class="stat-desc">Offline-first enabled</div>
    </div>
  </div>

  <!-- Placeholder: developers replace this with their collections -->
  <div class="card bg-base-100 shadow">
    <div class="card-body">
      <h2 class="card-title">Getting Started</h2>
      <p class="text-base-content/60">
        This is a template dashboard. Use <code class="badge badge-ghost">useCollection('your_collection')</code>
        to connect to your Zveltio data with offline-first support.
      </p>
      <pre class="bg-base-200 p-4 rounded-lg text-sm mt-2"><code>{codeExample}</code></pre>
    </div>
  </div>
</div>
