<script lang="ts">
/**
 * Spatial explore — `near` and bounding-box (`within`) filters on a collection's
 * `location` field, through the data API (ADR 0019). The engine answers them
 * under the caller's own rules; this page only builds the filter.
 */
import MapView from '#lib/ext/geospatial/postgis/components/MapView.svelte';
import { api } from '#lib/api.js';
import { toast } from '#lib/stores/toast.svelte.js';

type Mode = 'near' | 'bbox';

let mode = $state<Mode>('near');
let collection = $state('');
let collections = $state<string[]>([]);
let field = $state('location');
let lat = $state(45.94);
let lng = $state(24.97);
let radius = $state(5000);
let minLat = $state(45.9);
let maxLat = $state(46.0);
let minLng = $state(24.9);
let maxLng = $state(25.0);
let items = $state<Record<string, unknown>[]>([]);
let raw = $state('');
let running = $state(false);

async function loadCollections(): Promise<void> {
  try {
    const r = await api.get<{ collections?: Array<{ name: string }> }>('/api/collections');
    collections = (r.collections ?? []).map((c) => c.name);
    if (!collection && collections[0]) collection = collections[0];
  } catch {
    collections = [];
  }
}

async function run(): Promise<void> {
  if (!collection) {
    toast.warning('Pick a collection');
    return;
  }
  // A field name goes into the query key `${field}[op]`; anything but an
  // identifier would build a different filter than the one asked for.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) {
    toast.error('The location field must be a field name (letters, digits, underscore)');
    return;
  }
  running = true;
  try {
    const [op, value] =
      mode === 'near' ? ['near', `${lat},${lng},${radius}`] : ['within', `${minLat},${minLng},${maxLat},${maxLng}`];
    const qs = new URLSearchParams({ [`${field}[${op}]`]: value, limit: '500' });
    const r = await api.get<{ records?: Record<string, unknown>[] }>(
      `/api/data/${encodeURIComponent(collection)}?${qs}`,
    );
    raw = JSON.stringify(r, null, 2);
    items = Array.isArray(r.records) ? r.records : [];
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Query failed');
    items = [];
  } finally {
    running = false;
  }
}

$effect(() => {
  void loadCollections();
});
</script>

<div class="space-y-4">
  <div class="flex items-center gap-2 flex-wrap">
    <h1 class="font-semibold text-lg flex-1">Spatial explore</h1>
    <div class="join">
      {#each ['near', 'bbox'] as m}
        <button
          type="button"
          class="btn btn-sm join-item {mode === m ? 'btn-active' : ''}"
          onclick={() => (mode = m as Mode)}
        >
          {m}
        </button>
      {/each}
    </div>
  </div>

  <div class="grid grid-cols-1 lg:grid-cols-3 gap-3">
    <div class="space-y-2">
      <label class="form-control">
        <span class="label-text text-xs">Collection</span>
        <select class="select select-bordered select-sm" bind:value={collection}>
          {#each collections as c}
            <option value={c}>{c}</option>
          {/each}
        </select>
      </label>

      <label class="form-control"><span class="label-text text-xs">Location field</span><input class="input input-bordered input-sm" bind:value={field} /></label>

      {#if mode === 'near'}
        <label class="form-control"><span class="label-text text-xs">Lat</span><input type="number" step="any" class="input input-bordered input-sm" bind:value={lat} /></label>
        <label class="form-control"><span class="label-text text-xs">Lng</span><input type="number" step="any" class="input input-bordered input-sm" bind:value={lng} /></label>
        <label class="form-control"><span class="label-text text-xs">Radius (m)</span><input type="number" class="input input-bordered input-sm" bind:value={radius} /></label>
      {:else}
        <div class="grid grid-cols-2 gap-2">
          <label class="form-control"><span class="label-text text-xs">min lat</span><input type="number" step="any" class="input input-bordered input-sm" bind:value={minLat} /></label>
          <label class="form-control"><span class="label-text text-xs">max lat</span><input type="number" step="any" class="input input-bordered input-sm" bind:value={maxLat} /></label>
          <label class="form-control"><span class="label-text text-xs">min lng</span><input type="number" step="any" class="input input-bordered input-sm" bind:value={minLng} /></label>
          <label class="form-control"><span class="label-text text-xs">max lng</span><input type="number" step="any" class="input input-bordered input-sm" bind:value={maxLng} /></label>
        </div>
      {/if}

      <button type="button" class="btn btn-primary btn-sm w-full" disabled={running} onclick={() => void run()}>
        {running ? '…' : 'Run query'}
      </button>
      <p class="text-xs opacity-50">{items.length} map item(s)</p>
    </div>

    <div class="lg:col-span-2 space-y-2">
      <MapView {items} height="360px" />
      <pre class="text-xs font-mono max-h-48 overflow-auto border border-base-300 rounded-lg p-2 bg-base-200/40">{raw || '—'}</pre>
    </div>
  </div>
</div>
