<script lang="ts">
  /**
   * Plot a collection's records on a map.
   *
   * Was `<div class="MapView">MapView Component</div>` — a placeholder that
   * shipped alongside a working `MapPicker`, which is why the gap survived: the
   * extension demonstrably did maps, just not this one.
   *
   * Coordinates are discovered rather than declared. A record may carry
   * `lat`/`lng`, `latitude`/`longitude`, a GeoJSON `geometry`, or a PostGIS
   * `location` column that arrives as `{ x, y }` or as GeoJSON depending on how
   * it was selected. Demanding one shape would mean every caller configures a
   * field before seeing anything, and the collections this renders were not
   * built to a single convention.
   */
  import { onMount, onDestroy } from 'svelte';
  import L from 'leaflet';
  import 'leaflet/dist/leaflet.css';

  let {
    items = [],
    height = '420px',
    onMarkerClick = null,
  }: {
    items: Record<string, unknown>[];
    height?: string;
    onMarkerClick?: ((item: Record<string, unknown>) => void) | null;
  } = $props();

  let mapElement: HTMLDivElement;
  let map: L.Map | null = null;
  let layer: L.LayerGroup | null = null;

  const TITLE_FIELDS = ['name', 'title', 'label', 'address'];

  /** Somewhere central enough to not look broken when nothing has coordinates. */
  const FALLBACK_CENTER: [number, number] = [45.9432, 24.9668];

  function numeric(v: unknown): number | null {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  /**
   * Pull [lat, lng] out of whatever shape a record uses.
   *
   * GeoJSON stores coordinates as [longitude, latitude] — the reverse of how
   * every map API takes them. Getting that backwards puts European records in
   * the Indian Ocean, silently, which is the kind of bug that looks like "the
   * map is broken" rather than "the order is wrong".
   */
  function coordsOf(item: Record<string, unknown>): [number, number] | null {
    const lat = numeric(item.lat) ?? numeric(item.latitude);
    const lng = numeric(item.lng) ?? numeric(item.lon) ?? numeric(item.longitude);
    if (lat !== null && lng !== null) return [lat, lng];

    for (const key of ['geometry', 'location', 'geom', 'point']) {
      const g = item[key];
      if (!g || typeof g !== 'object') continue;

      const geo = g as { type?: string; coordinates?: unknown; x?: unknown; y?: unknown };
      if (geo.type === 'Point' && Array.isArray(geo.coordinates)) {
        const lngV = numeric(geo.coordinates[0]);
        const latV = numeric(geo.coordinates[1]);
        if (latV !== null && lngV !== null) return [latV, lngV];
      }
      // PostGIS selected as a plain point: x is longitude, y is latitude.
      const x = numeric(geo.x);
      const y = numeric(geo.y);
      if (x !== null && y !== null) return [y, x];
    }
    return null;
  }

  function titleOf(item: Record<string, unknown>): string {
    for (const f of TITLE_FIELDS) {
      const v = item[f];
      if (typeof v === 'string' && v.trim()) return v;
    }
    return String(item.id ?? '—');
  }

  /** Escape before it reaches a Leaflet popup, which takes an HTML string. */
  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const placed = $derived(
    items
      .map((item) => ({ item, coords: coordsOf(item) }))
      .filter((e): e is { item: Record<string, unknown>; coords: [number, number] } =>
        e.coords !== null,
      ),
  );

  function draw() {
    if (!map) return;
    layer?.clearLayers();
    if (!layer) layer = L.layerGroup().addTo(map);

    for (const { item, coords } of placed) {
      const marker = L.marker(coords).bindPopup(escapeHtml(titleOf(item)));
      if (onMarkerClick) marker.on('click', () => onMarkerClick(item));
      layer.addLayer(marker);
    }

    if (placed.length > 0) {
      map.fitBounds(L.latLngBounds(placed.map((p) => p.coords)), {
        padding: [32, 32],
        maxZoom: 15,
      });
    }
  }

  onMount(() => {
    // Leaflet's default marker icons resolve relative to the CSS, which breaks
    // under a bundler. Same override MapPicker needs.
    delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
    L.Icon.Default.mergeOptions({
      iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
      iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
      shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
    });

    map = L.map(mapElement).setView(FALLBACK_CENTER, 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
    }).addTo(map);

    draw();
  });

  onDestroy(() => {
    map?.remove();
    map = null;
    layer = null;
  });

  // Redraw when the caller swaps the record set.
  $effect(() => {
    void placed;
    draw();
  });
</script>

<div class="relative">
  <div bind:this={mapElement} style="height: {height}" class="rounded border border-base-300"></div>

  {#if items.length > 0 && placed.length === 0}
    <div class="absolute inset-0 flex items-center justify-center bg-base-100/80 rounded text-sm opacity-70 pointer-events-none">
      None of these records carry coordinates.
    </div>
  {/if}
</div>

{#if placed.length > 0 && placed.length < items.length}
  <div class="text-xs opacity-60 mt-1">
    {placed.length} of {items.length} records have coordinates.
  </div>
{/if}
