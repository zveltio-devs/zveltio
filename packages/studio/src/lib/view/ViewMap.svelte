<script lang="ts">
/**
 * `map`: the records of a collection with a `location` (`{ lat, lng }`, the
 * engine's `location` field), as points on a Leaflet map and as a list under
 * it, which is also what a reader without the map gets. A point or a list
 * entry selects its record (`$selected` of the view's `id`). With the
 * instance's tiles off (ADR 0043) it draws the list only.
 */
import 'leaflet/dist/leaflet.css';
import L, { type Map as LeafletMap } from 'leaflet';
import { type MapTiles, mapTiles } from '#lib/map-tiles.js';
import { type MapView, viewFields, type ViewScope } from '@zveltio/sdk/view';
import { listParams, type ViewHost, WHOLE } from './engine.js';
import { readRows, type Row } from './rows.svelte.js';
import ViewRows from './ViewRows.svelte';
import ViewValue from './ViewValue.svelte';

interface Props {
  view: MapView;
  host: ViewHost;
  scope: ViewScope;
}
const { view, host, scope }: Props = $props();

const data = readRows(() => ({
  collection: view.collection,
  params: listParams({ filter: view.filter }, scope, { page: 1, limit: WHOLE }),
  version: host.version,
}));

const labelField = $derived(
  view.label ??
    (viewFields(undefined, data.schema, 'list') as string[]).find((f) => f !== view.location) ??
    'id',
);

const point = (v: unknown): { lat: number; lng: number } | null => {
  const { lat, lng } = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  return typeof lat === 'number' && typeof lng === 'number' ? { lat, lng } : null;
};
const placed = $derived(
  data.rows.flatMap((row) => {
    const p = point(row[view.location]);
    return p ? [{ row, ...p }] : [];
  }),
);

function pick(row: Row) {
  if (view.id) host.scope.selected[view.id] = row.id;
}

let tiles = $state<MapTiles | null>(null);
mapTiles().then((t) => {
  tiles = t;
});

let el = $state<HTMLDivElement | null>(null);
let map: LeafletMap | null = null;
$effect(() => {
  const node = el;
  if (!node || !tiles) return;
  // The element is new when the list was redrawn: the map goes with the old one.
  if (map && map.getContainer() !== node) {
    map.remove();
    map = null;
  }
  map ??= L.map(node);
  const lm = map;
  lm.eachLayer((l) => void lm.removeLayer(l));
  L.tileLayer(tiles.url, { attribution: tiles.attribution, maxZoom: 19 }).addTo(lm);
  for (const p of placed) {
    // A circle needs no marker image from a CDN. Leaflet reads a string tooltip
    // as HTML; record values are untrusted, so the label goes in as a text node.
    const tip = document.createElement('span');
    tip.textContent = String(p.row[labelField] ?? p.row.id);
    L.circleMarker([p.lat, p.lng], { radius: 7 })
      .bindTooltip(tip)
      .on('click', () => pick(p.row))
      .addTo(lm);
  }
  if (placed.length)
    lm.fitBounds(L.latLngBounds(placed.map((p) => [p.lat, p.lng])), { maxZoom: 14 });
  else lm.setView([0, 0], 1);
});
$effect(() => () => {
  map?.remove();
  map = null;
});
</script>

<div class="space-y-3" data-testid="view-map">
  <ViewRows rows={data} always>
    {#if tiles}
      <div bind:this={el} class="h-96 w-full rounded-box border border-base-200 z-0"></div>
    {/if}
    <ul class="text-sm divide-y divide-base-200">
      {#each placed as p (p.row.id)}
        <li>
          <button
            type="button"
            class="w-full text-left py-1 flex justify-between gap-3"
            class:font-semibold={view.id && host.scope.selected[view.id] === p.row.id}
            onclick={() => pick(p.row)}
          >
            <ViewValue value={p.row[labelField]} hint={null} />
            <span class="font-mono text-xs text-base-content/60">{p.lat.toFixed(5)}, {p.lng.toFixed(5)}</span>
          </button>
        </li>
      {/each}
    </ul>
  </ViewRows>
</div>
