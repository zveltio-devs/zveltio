<script lang="ts">
import { m } from '$lib/i18n.svelte.js';
import ConfirmModal from '$lib/components/common/ConfirmModal.svelte';
import { createExtensionConfirm } from '$lib/utils/extension-confirm.svelte.js';
import ExtensionPageShell from '$lib/components/extension/ExtensionPageShell.svelte';
import ExtensionDataPanel from '$lib/components/extension/ExtensionDataPanel.svelte';
import { onMount } from 'svelte';
import { api } from '$lib/api.js';
import { toast } from '$lib/stores/toast.svelte.js';
import { MapPin, Search, LoaderCircle } from '@lucide/svelte';

const { confirmState, askConfirm, runConfirmAction, cancelConfirm } = createExtensionConfirm();

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let geofences = $state<any[]>([]);
let loading = $state(true);
let activeTab = $state<'proximity' | 'geofences' | 'cluster'>('proximity');

let nearForm = $state({
  collection: '',
  location_field: 'location',
  lat: 0,
  lng: 0,
  radius_meters: 1000,
});
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
let nearResults = $state<any[]>([]);
let searching = $state(false);

let newGeofenceName = $state('');
let coordinatesJson = $state('');
let creating = $state(false);

onMount(loadGeofences);

async function loadGeofences() {
  loading = true;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const data = await api.get<{ geofences: any[] }>('/ext/geospatial/postgis/geofences');
    geofences = data.geofences ?? [];
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.loadFailed']());
  } finally {
    loading = false;
  }
}

async function searchNear() {
  if (!nearForm.collection) return;
  searching = true;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const data = await api.post<{ records: any[] }>('/ext/geospatial/postgis/near', nearForm);
    nearResults = data.records ?? [];
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e?.message ?? m['ai.error.searchFailed']());
  } finally {
    searching = false;
  }
}

async function createGeofence() {
  if (!newGeofenceName || !coordinatesJson) return;
  creating = true;
  try {
    const coordinates = JSON.parse(coordinatesJson);
    await api.post('/ext/geospatial/postgis/geofences', { name: newGeofenceName, coordinates });
    newGeofenceName = '';
    coordinatesJson = '';
    await loadGeofences();
    toast.success(m['ext.created']());
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e?.message ?? 'Invalid coordinates JSON');
  } finally {
    creating = false;
  }
}

async function deleteGeofence(id: string) {
  askConfirm(m['geospatial.postgis.confirmDelete'](), () => deleteGeofenceConfirmed(id));
}
async function deleteGeofenceConfirmed(id: string) {
  try {
    await api.delete(`/ext/geospatial/postgis/geofences/${id}`);
    await loadGeofences();
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (e: any) {
    toast.error(e instanceof Error ? e.message : m['ext.saveFailed']());
  }
}
</script>

<ExtensionPageShell title={m['geospatial.postgis.title']()} subtitle={m['geospatial.postgis.subtitle']()}>
<div class="tabs tabs-boxed bg-base-200 w-fit">
    <button class="tab {activeTab === 'proximity' ? 'tab-active' : ''}" onclick={() => (activeTab = 'proximity')}>{m['geospatial.postgis.tab.proximity']()}</button>
    <button class="tab {activeTab === 'geofences' ? 'tab-active' : ''}" onclick={() => (activeTab = 'geofences')}>{m['geospatial.postgis.tab.geofencesCount']({ n: String(geofences.length) })}</button>
    <button class="tab {activeTab === 'cluster' ? 'tab-active' : ''}" onclick={() => (activeTab = 'cluster')}>{m['geospatial.postgis.tab.clustering']()}</button>
</div>

{#if activeTab === 'proximity'}
    <div class="card bg-base-200 border border-base-300 max-w-xl">
      <div class="card-body gap-3">
        <h2 class="font-medium text-sm">{m['geospatial.postgis.ui.find_records_near_a_point']()}</h2>
        <div class="grid grid-cols-2 gap-3">
          <div class="form-control col-span-2"><label class="label py-0"><span class="label-text text-xs">{m['analytics.quality.ui.collection']()}</span></label><input type="text" bind:value={nearForm.collection} placeholder={m['geospatial.postgis.ui.locations']()} class="input input-sm" /></div>
          <div class="form-control col-span-2"><label class="label py-0"><span class="label-text text-xs">{m['geospatial.postgis.ui.location_field']()}</span></label><input type="text" bind:value={nearForm.location_field} class="input input-sm" /></div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['geospatial.postgis.ui.latitude']()}</span></label><input type="number" step="0.000001" bind:value={nearForm.lat} class="input input-sm" /></div>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['geospatial.postgis.ui.longitude']()}</span></label><input type="number" step="0.000001" bind:value={nearForm.lng} class="input input-sm" /></div>
          <div class="form-control col-span-2"><label class="label py-0"><span class="label-text text-xs">{m['geospatial.postgis.ui.radius_meters']()}</span></label><input type="number" bind:value={nearForm.radius_meters} class="input input-sm" /></div>
        </div>
        <button class="btn btn-primary btn-sm gap-1 w-fit" onclick={searchNear} disabled={searching || !nearForm.collection}>
          {#if searching}<LoaderCircle size={14} class="animate-spin" />{:else}<Search size={14} />{/if}{m['geospatial.postgis.btn.search']()}
        </button>
        {#if nearResults.length > 0}
          <div class="space-y-1 max-h-48 overflow-y-auto">
            <p class="text-xs font-medium">{m['geospatial.postgis.resultsCount']({ n: String(nearResults.length) })}</p>
            {#each nearResults as r (r.id)}
              <div class="bg-base-300 rounded p-2 text-xs font-mono flex justify-between">
                <span>{r.id?.slice(0, 8)}…</span>
                <span class="text-base-content/60">{m['geospatial.postgis.distanceMeters']({ d: String(Math.round(r.distance_meters)) })}</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>

  {:else if activeTab === 'geofences'}
    <div class="grid grid-cols-1 gap-4 max-w-2xl">
      <div class="card bg-base-200 border border-base-300">
        <div class="card-body p-4 gap-3">
          <h2 class="font-medium text-sm">{m['geospatial.postgis.ui.new_geofence']()}</h2>
          <div class="form-control"><label class="label py-0"><span class="label-text text-xs">{m['common.col.name']()}</span></label><input type="text" bind:value={newGeofenceName} placeholder={m['geospatial.postgis.ui.city_center_zone']()} class="input input-sm" /></div>
          <div class="form-control">
            <label class="label py-0"><span class="label-text text-xs">{m['geospatial.postgis.ui.coordinates_geojson_polygon_array']()}</span></label>
            <textarea bind:value={coordinatesJson} placeholder='[[[lng1,lat1],[lng2,lat2],[lng3,lat3],[lng1,lat1]]]' class="textarea textarea-sm font-mono text-xs" rows="4"></textarea>
          </div>
          <button class="btn btn-primary btn-sm gap-1 w-fit" onclick={createGeofence} disabled={creating}>
            {#if creating}<LoaderCircle size={14} class="animate-spin" />{:else}<MapPin size={14} />{/if}{m['geospatial.postgis.btn.create']()}
          </button>
        </div>
      </div>

      {#if loading}
        <div class="flex justify-center py-6"><LoaderCircle size={24} class="animate-spin text-primary" /></div>
      {:else if geofences.length === 0}
        <p class="text-base-content/50 text-sm text-center py-4">{m['geospatial.postgis.empty.geofences']()}</p>
      {:else}
        {#each geofences as gf (gf.id)}
          <div class="card bg-base-200 border border-base-300">
            <div class="card-body p-3 flex-row items-center gap-3">
              <div class="flex-1">
                <p class="font-medium text-sm">{gf.name}</p>
                {#if gf.description}<p class="text-xs text-base-content/50">{gf.description}</p>{/if}
                <p class="text-xs text-base-content/40 mt-0.5">{new Date(gf.created_at).toLocaleDateString()}</p>
              </div>
              <button class="btn btn-ghost btn-xs text-error" onclick={() => deleteGeofence(gf.id)}>{m['common.delete']()}</button>
            </div>
          </div>
        {/each}
      {/if}
    </div>

  {:else}
    <div class="card bg-base-200 border border-base-300 max-w-xl">
      <div class="card-body gap-3">
        <h2 class="font-medium text-sm">{m['geospatial.postgis.ui.point_clustering_dbscan']()}</h2>
        <p class="text-sm text-base-content/60">{m['geospatial.postgis.cluster.apiHint']()} <code class="badge badge-ghost badge-sm">POST /ext/geospatial/postgis/cluster</code> with parameters:</p>
        <pre class="bg-base-300 rounded p-3 text-xs font-mono">{JSON.stringify({ collection: "your_collection", location_field: "location", eps_meters: 500, min_points: 3 }, null, 2)}</pre>
        <p class="text-sm text-base-content/60">{m['geospatial.postgis.cluster.returnsHint']()}</p>
      </div>
    </div>
  {/if}

<ConfirmModal
  open={confirmState.open}
  title={confirmState.title}
  message={confirmState.message}
  confirmLabel={confirmState.confirmLabel}
  confirmClass={confirmState.confirmClass}
  onconfirm={runConfirmAction}
  oncancel={cancelConfirm}
/>

</ExtensionPageShell>
