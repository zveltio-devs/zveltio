<script lang="ts">
 import { onMount, onDestroy } from 'svelte';
 import L from 'leaflet';
 import 'leaflet/dist/leaflet.css';
import { MapPin, Navigation } from '@lucide/svelte';

 interface GeoLocation { lat: number; lng: number; }

 interface Props {
 value?: GeoLocation | null;
 readonly?: boolean;
 }

 let { value = $bindable<GeoLocation | null>(null), readonly = false }: Props = $props();

 let mapElement: HTMLDivElement;
 let map: L.Map | null = null;
 let marker: L.Marker | null = null;

 const defaultCenter: [number, number] = [44.4268, 26.1025];
 const defaultZoom = 13;

 onMount(() => {
 delete (L.Icon.Default.prototype as any)._getIconUrl;
 L.Icon.Default.mergeOptions({
 iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
 iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
 shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
 });

 map = L.map(mapElement).setView(value ? [value.lat, value.lng] : defaultCenter, defaultZoom);
 L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
 attribution: '© OpenStreetMap',
 }).addTo(map);

 if (value) marker = L.marker([value.lat, value.lng]).addTo(map);

 if (!readonly) {
 map.on('click', (e: L.LeafletMouseEvent) => setLocation(e.latlng.lat, e.latlng.lng));
 }
 });

 onDestroy(() => { map?.remove(); });

 function setLocation(lat: number, lng: number) {
 value = { lat, lng };
 if (marker) {
 marker.setLatLng([lat, lng]);
 } else {
 marker = L.marker([lat, lng]).addTo(map!);
 }
 map?.panTo([lat, lng]);
 }

 function getCurrentLocation() {
 if (!navigator.geolocation) { alert('Geolocation not supported'); return; }
 navigator.geolocation.getCurrentPosition(
 (pos) => setLocation(pos.coords.latitude, pos.coords.longitude),
 (err) => alert('Failed to get location: ' + err.message)
 );
 }

 function clearLocation() {
 value = null;
 if (marker) { map?.removeLayer(marker); marker = null; }
 }
</script>

<div class="map-picker">
 <div class="controls p-2 bg-base-200 border-b border-base-300 flex items-center justify-between">
 <div class="flex items-center gap-2">
 {#if value}
 <div class="badge badge-sm gap-1"><MapPin size={12} />{value.lat.toFixed(6)}, {value.lng.toFixed(6)}</div>
 {:else}
 <span class="text-xs opacity-50">Click map to set location</span>
 {/if}
 </div>
 {#if !readonly}
 <div class="flex gap-1">
 <button type="button" class="btn btn-xs btn-ghost gap-1" onclick={getCurrentLocation}>
 <Navigation size={12} /> Use My Location
 </button>
 {#if value}
 <button type="button" class="btn btn-xs btn-ghost" onclick={clearLocation}>Clear</button>
 {/if}
 </div>
 {/if}
 </div>
 <div bind:this={mapElement} class="map-container"></div>
</div>

<style>
 .map-picker { border: 1px solid hsl(var(--bc) / 0.2); border-radius: 0.5rem; overflow: hidden; }
 .map-container { width: 100%; height: 16rem; }
</style>
