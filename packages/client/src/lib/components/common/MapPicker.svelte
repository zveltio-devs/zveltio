<script lang="ts">
  interface Props {
    lat?: number;
    lng?: number;
    zoom?: number;
    onSelect?: (lat: number, lng: number) => void;
  }

  let { lat = 44.4268, lng = 26.1025, zoom = 13, onSelect }: Props = $props();

  let mapEl: HTMLDivElement;
  let mapInstance: any = null;

  $effect(() => {
    if (typeof window === 'undefined' || !mapEl) return;

    // Dynamic import — SSR-safe
    import('leaflet').then((L) => {
      // @ts-ignore
      import('leaflet/dist/leaflet.css');

      if (mapInstance) mapInstance.remove();

      mapInstance = L.map(mapEl).setView([lat, lng], zoom);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap',
      }).addTo(mapInstance);

      const marker = L.marker([lat, lng], { draggable: !!onSelect }).addTo(mapInstance);

      if (onSelect) {
        marker.on('dragend', () => {
          const pos = marker.getLatLng();
          onSelect(pos.lat, pos.lng);
        });

        mapInstance.on('click', (e: any) => {
          marker.setLatLng(e.latlng);
          onSelect(e.latlng.lat, e.latlng.lng);
        });
      }
    });

    return () => {
      mapInstance?.remove();
      mapInstance = null;
    };
  });
</script>

<div bind:this={mapEl} class="w-full h-64 rounded-lg border border-base-300 z-0"></div>
