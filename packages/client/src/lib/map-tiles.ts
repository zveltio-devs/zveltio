/**
 * The instance's map tile server (ADR 0043). The root layout reads the public
 * settings once and hands `map_tiles` here; every map reads it from here and
 * none names a tile host. Null: tiles off, or the settings were not read.
 */
export interface MapTiles {
  url: string;
  /** Escaped: Leaflet's `attribution` option is HTML, the setting is text. */
  attribution: string;
}

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

let tiles: MapTiles | null = null;

export function setMapTiles(value: unknown): void {
  const t = value as { url?: unknown; attribution?: unknown } | null;
  tiles =
    typeof t?.url === 'string' && typeof t.attribution === 'string'
      ? { url: t.url, attribution: t.attribution.replace(/[&<>"']/g, (c) => ESC[c]) }
      : null;
}

export function mapTiles(): MapTiles | null {
  return tiles;
}
