<script lang="ts">
/**
 * PostGIS explore — near / cluster / bbox against /ext/geospatial/postgis.
 */
import MapView from '$lib/ext/geospatial/postgis/components/MapView.svelte';
import { api } from '$lib/api.js';
import { toast } from '$lib/stores/toast.svelte.js';

const API = '/ext/geospatial/postgis';

type Mode = 'near' | 'cluster' | 'bbox';

let mode = $state<Mode>('near');
let collection = $state('');
let collections = $state<string[]>([]);
let lat = $state(45.94);
let lng = $state(24.97);
let radius = $state(5000);
let eps = $state(1000);
let minPoints = $state(2);
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

function clusterToItems(clusters: Array<{ centroid?: unknown; point_count?: number; cluster_id?: unknown }>) {
  return clusters.map((c, i) => {
    const g = c.centroid as { type?: string; coordinates?: number[] } | null;
    const coords = g?.coordinates;
    return {
      id: String(c.cluster_id ?? i),
      name: `Cluster ${c.cluster_id ?? i} (${c.point_count ?? 0})`,
      lat: Array.isArray(coords) ? coords[1] : null,
      lng: Array.isArray(coords) ? coords[0] : null,
      geometry: c.centroid,
    };
  });
}

async function run(): Promise<void> {
  if (!collection) {
    toast.warning('Pick a collection');
    return;
  }
  running = true;
  try {
    let path = '';
    let body: Record<string, unknown> = { collection, location_field: 'location' };
    if (mode === 'near') {
      path = `${API}/near`;
      body = { ...body, lat, lng, radius_meters: radius };
    } else if (mode === 'cluster') {
      path = `${API}/cluster`;
      body = { ...body, eps_meters: eps, min_points: minPoints };
    } else {
      path = `${API}/within-bbox`;
      body = { ...body, min_lat: minLat, max_lat: maxLat, min_lng: minLng, max_lng: maxLng };
    }
    const r = await api.post<Record<string, unknown>>(path, body);
    raw = JSON.stringify(r, null, 2);
    if (mode === 'cluster' && Array.isArray(r.clusters)) {
      items = clusterToItems(r.clusters as never[]);
    } else if (Array.isArray(r.records)) {
      items = r.records as Record<string, unknown>[];
    } else if (Array.isArray(r.results)) {
      items = r.results as Record<string, unknown>[];
    } else if (Array.isArray(r.data)) {
      items = r.data as Record<string, unknown>[];
    } else {
      items = [];
    }
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
      {#each ['near', 'cluster', 'bbox'] as m}
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

      {#if mode === 'near'}
        <label class="form-control"><span class="label-text text-xs">Lat</span><input type="number" step="any" class="input input-bordered input-sm" bind:value={lat} /></label>
        <label class="form-control"><span class="label-text text-xs">Lng</span><input type="number" step="any" class="input input-bordered input-sm" bind:value={lng} /></label>
        <label class="form-control"><span class="label-text text-xs">Radius (m)</span><input type="number" class="input input-bordered input-sm" bind:value={radius} /></label>
      {:else if mode === 'cluster'}
        <label class="form-control"><span class="label-text text-xs">EPS (m)</span><input type="number" class="input input-bordered input-sm" bind:value={eps} /></label>
        <label class="form-control"><span class="label-text text-xs">Min points</span><input type="number" class="input input-bordered input-sm" bind:value={minPoints} /></label>
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
