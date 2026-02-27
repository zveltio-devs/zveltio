<script lang="ts">
  import { onMount } from 'svelte';
  import { MapPin, Search, Crosshair } from '@lucide/svelte';

  const engineUrl = (window as any).__ZVELTIO_ENGINE_URL__ || '';

  let geofences = $state<any[]>([]);
  let loading = $state(true);
  let activeTab = $state<'proximity' | 'geofences' | 'cluster'>('proximity');

  // Proximity search
  let nearForm = $state({ collection: '', location_field: 'location', lat: 0, lng: 0, radius_meters: 1000 });
  let nearResults = $state<any[]>([]);
  let searching = $state(false);

  // Geofence creation
  let newGeofenceName = $state('');
  let coordinatesJson = $state('');
  let creating = $state(false);

  onMount(async () => {
    await loadGeofences();
  });

  async function loadGeofences() {
    loading = true;
    try {
      const res = await fetch(`${engineUrl}/api/geo/geofences`, { credentials: 'include' });
      const data = await res.json();
      geofences = data.geofences || [];
    } finally {
      loading = false;
    }
  }

  async function searchNear() {
    if (!nearForm.collection) return;
    searching = true;
    try {
      const res = await fetch(`${engineUrl}/api/geo/near`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nearForm),
      });
      const data = await res.json();
      nearResults = data.records || [];
    } finally {
      searching = false;
    }
  }

  async function createGeofence() {
    if (!newGeofenceName || !coordinatesJson) return;
    creating = true;
    try {
      const coordinates = JSON.parse(coordinatesJson);
      await fetch(`${engineUrl}/api/geo/geofences`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newGeofenceName, coordinates }),
      });
      newGeofenceName = '';
      coordinatesJson = '';
      await loadGeofences();
    } catch (e) {
      alert('Invalid coordinates JSON');
    } finally {
      creating = false;
    }
  }

  async function deleteGeofence(id: string) {
    if (!confirm('Delete this geofence?')) return;
    await fetch(`${engineUrl}/api/geo/geofences/${id}`, { method: 'DELETE', credentials: 'include' });
    await loadGeofences();
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-bold">Geospatial</h1>
    <p class="text-base-content/60 text-sm mt-1">PostGIS-powered proximity search and geofencing</p>
  </div>

  <div class="tabs tabs-boxed w-fit">
    <button class="tab {activeTab === 'proximity' ? 'tab-active' : ''}" onclick={() => (activeTab = 'proximity')}>
      Proximity Search
    </button>
    <button class="tab {activeTab === 'geofences' ? 'tab-active' : ''}" onclick={() => (activeTab = 'geofences')}>
      Geofences ({geofences.length})
    </button>
    <button class="tab {activeTab === 'cluster' ? 'tab-active' : ''}" onclick={() => (activeTab = 'cluster')}>
      Clustering
    </button>
  </div>

  {#if activeTab === 'proximity'}
    <div class="card bg-base-200 max-w-xl">
      <div class="card-body">
        <h2 class="card-title text-base">Find Records Near a Point</h2>
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control col-span-2">
            <label class="label"><span class="label-text">Collection</span></label>
            <input type="text" bind:value={nearForm.collection} placeholder="locations" class="input input-bordered input-sm" />
          </div>
          <div class="form-control col-span-2">
            <label class="label"><span class="label-text">Location field</span></label>
            <input type="text" bind:value={nearForm.location_field} class="input input-bordered input-sm" />
          </div>
          <div class="form-control">
            <label class="label"><span class="label-text">Latitude</span></label>
            <input type="number" step="0.000001" bind:value={nearForm.lat} class="input input-bordered input-sm" />
          </div>
          <div class="form-control">
            <label class="label"><span class="label-text">Longitude</span></label>
            <input type="number" step="0.000001" bind:value={nearForm.lng} class="input input-bordered input-sm" />
          </div>
          <div class="form-control col-span-2">
            <label class="label"><span class="label-text">Radius (meters)</span></label>
            <input type="number" bind:value={nearForm.radius_meters} class="input input-bordered input-sm" />
          </div>
        </div>
        <button class="btn btn-primary btn-sm gap-2 mt-2" onclick={searchNear} disabled={searching}>
          {#if searching}
            <span class="loading loading-spinner loading-xs"></span>
          {:else}
            <Search size={14} />
          {/if}
          Search
        </button>

        {#if nearResults.length > 0}
          <div class="mt-4">
            <p class="text-sm font-medium mb-2">{nearResults.length} results</p>
            <div class="space-y-2 max-h-64 overflow-y-auto">
              {#each nearResults as r}
                <div class="bg-base-300 rounded p-2 text-xs font-mono">
                  <div class="flex justify-between">
                    <span class="font-medium">{r.id?.slice(0, 8)}...</span>
                    <span class="text-base-content/60">{Math.round(r.distance_meters)}m away</span>
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    </div>

  {:else if activeTab === 'geofences'}
    <div class="grid grid-cols-1 gap-4 max-w-2xl">
      <!-- Create geofence -->
      <div class="card bg-base-200">
        <div class="card-body">
          <h2 class="card-title text-base">New Geofence</h2>
          <div class="form-control">
            <label class="label"><span class="label-text">Name</span></label>
            <input type="text" bind:value={newGeofenceName} placeholder="City Center Zone" class="input input-bordered input-sm" />
          </div>
          <div class="form-control">
            <label class="label">
              <span class="label-text">Coordinates (GeoJSON polygon array)</span>
            </label>
            <textarea
              bind:value={coordinatesJson}
              placeholder='[[[lng1,lat1],[lng2,lat2],[lng3,lat3],[lng1,lat1]]]'
              class="textarea textarea-bordered textarea-sm font-mono text-xs"
              rows="4"
            ></textarea>
          </div>
          <button class="btn btn-primary btn-sm gap-2" onclick={createGeofence} disabled={creating}>
            {#if creating}<span class="loading loading-spinner loading-xs"></span>{:else}<MapPin size={14} />{/if}
            Create Geofence
          </button>
        </div>
      </div>

      <!-- Geofence list -->
      {#if loading}
        <div class="flex justify-center py-6"><span class="loading loading-spinner"></span></div>
      {:else if geofences.length === 0}
        <p class="text-base-content/40 text-center py-4">No geofences yet</p>
      {:else}
        {#each geofences as gf}
          <div class="card bg-base-200">
            <div class="card-body p-3">
              <div class="flex items-center justify-between">
                <div>
                  <h3 class="font-semibold text-sm">{gf.name}</h3>
                  {#if gf.description}<p class="text-xs text-base-content/50">{gf.description}</p>{/if}
                  <p class="text-xs text-base-content/40 mt-0.5">{new Date(gf.created_at).toLocaleDateString()}</p>
                </div>
                <button class="btn btn-ghost btn-xs text-error" onclick={() => deleteGeofence(gf.id)}>Delete</button>
              </div>
            </div>
          </div>
        {/each}
      {/if}
    </div>

  {:else if activeTab === 'cluster'}
    <div class="card bg-base-200 max-w-xl">
      <div class="card-body">
        <h2 class="card-title text-base">Point Clustering (DBSCAN)</h2>
        <p class="text-sm text-base-content/60">
          Use the API endpoint <code class="font-mono">POST /api/geo/cluster</code> with parameters:
        </p>
        <pre class="bg-base-300 rounded p-3 text-xs font-mono mt-2">{JSON.stringify({
  collection: "your_collection",
  location_field: "location",
  eps_meters: 500,
  min_points: 3
}, null, 2)}</pre>
        <p class="text-sm text-base-content/60 mt-2">
          Returns clusters with centroid coordinates and point counts.
        </p>
      </div>
    </div>
  {/if}
</div>
