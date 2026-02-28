<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import L from 'leaflet';
  import 'leaflet/dist/leaflet.css';
  import MapPin from '@lucide/svelte/icons/map-pin.svelte';
  import Navigation from '@lucide/svelte/icons/navigation.svelte';
  import X from '@lucide/svelte/icons/x.svelte';

  interface GeoLocation { lat: number; lng: number; }

  interface Props {
    value?: GeoLocation | null;
    readonly?: boolean;
    defaultLat?: number;
    defaultLng?: number;
    height?: string;
  }

  let {
    value = $bindable<GeoLocation | null>(null),
    readonly = false,
    defaultLat = 44.4268,
    defaultLng = 26.1025,
    height = '300px',
  }: Props = $props();

  let mapElement: HTMLDivElement;
  let map: L.Map | null = null;
  let marker: L.Marker | null = null;

  let lat = $state(value?.lat ?? 44.4268);
  let lng = $state(value?.lng ?? 26.1025);
  let disabled = $derived(readonly);
  const defaultZoom = 13;

  $effect(() => {
    if (value?.lat !== undefined && value?.lng !== undefined) {
      lat = value.lat;
      lng = value.lng;
      marker?.setLatLng([lat, lng]);
      map?.setView([lat, lng], defaultZoom);
    }
  });

  onMount(() => {
    delete (L.Icon.Default.prototype as any)._getIconUrl;
    L.Icon.Default.mergeOptions({
      iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
      iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
      shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
    });

    map = L.map(mapElement).setView([lat, lng], defaultZoom);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);

    if (value?.lat !== undefined && value?.lng !== undefined) {
      marker = L.marker([value.lat, value.lng]).addTo(map);
    }

    if (!readonly) {
      map.on('click', (e: L.LeafletMouseEvent) => setLocation(e.latlng.lat, e.latlng.lng));
    }
  });

  onDestroy(() => { map?.remove(); });

  function setLocation(newLat: number, newLng: number) {
    lat = newLat;
    lng = newLng;
    value = { lat, lng };
    if (marker) {
      marker.setLatLng([lat, lng]);
    } else if (map) {
      marker = L.marker([lat, lng]).addTo(map);
    }
    map?.panTo([lat, lng]);
  }

  function getCurrentLocation() {
    if (!navigator.geolocation) { alert('Geolocation is not supported'); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => setLocation(pos.coords.latitude, pos.coords.longitude),
      (err) => alert('Failed to get location: ' + err.message),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  }

  function clearLocation() {
    value = null;
    lat = defaultLat;
    lng = defaultLng;
    if (marker) { map?.removeLayer(marker); marker = null; }
  }

  function onLatChange(newLat: number) { if (!isNaN(newLat)) setLocation(newLat, lng); }
  function onLngChange(newLng: number) { if (!isNaN(newLng)) setLocation(lat, newLng); }
</script>

<div class="location-field">
  <div class="flex gap-2 mb-2">
    <div class="flex-1">
      <label class="label py-1" for="lat-input"><span class="label-text text-xs">Latitude</span></label>
      <input id="lat-input" type="number" class="input input-bordered input-sm w-full" placeholder="Latitude"
        step="0.000001" min="-90" max="90" {disabled} value={lat}
        onchange={(e) => onLatChange(parseFloat((e.target as HTMLInputElement).value))} />
    </div>
    <div class="flex-1">
      <label class="label py-1" for="lng-input"><span class="label-text text-xs">Longitude</span></label>
      <input id="lng-input" type="number" class="input input-bordered input-sm w-full" placeholder="Longitude"
        step="0.000001" min="-180" max="180" {disabled} value={lng}
        onchange={(e) => onLngChange(parseFloat((e.target as HTMLInputElement).value))} />
    </div>
  </div>

  <div bind:this={mapElement} class="map-container rounded-lg overflow-hidden border border-base-300"
    style="height: {height}; z-index: 1;"></div>

  <div class="flex items-center justify-between mt-2">
    <div class="flex items-center gap-2">
      {#if value}
        <div class="badge badge-sm badge-primary gap-1">
          <MapPin size={12} />{value.lat.toFixed(6)}, {value.lng.toFixed(6)}
        </div>
      {:else}
        <span class="text-xs opacity-50">Click on map to set location</span>
      {/if}
    </div>
    {#if !readonly}
      <div class="flex gap-1">
        <button type="button" class="btn btn-xs btn-ghost gap-1" onclick={getCurrentLocation} title="Use my current location">
          <Navigation size={12} /> My Location
        </button>
        {#if value}
          <button type="button" class="btn btn-xs btn-ghost text-error gap-1" onclick={clearLocation}>
            <X size={12} /> Clear
          </button>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .location-field { width: 100%; }
  .map-container { background-color: hsl(var(--b2)); }
  :global(.leaflet-container) { font-family: inherit; }
</style>
