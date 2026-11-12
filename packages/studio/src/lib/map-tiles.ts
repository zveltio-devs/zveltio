/**
 * The instance's map tile server (ADR 0043), from the public settings. Every map
 * reads it here; none names a tile host. Null when the operator turned tiles off
 * (`ZVELTIO_MAP_TILES=off`) or the settings cannot be read: the map then draws
 * no tiles rather than sending viewers to a host nobody chose.
 */
import { settingsApi } from '#lib/api.js';

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

export async function mapTiles(): Promise<MapTiles | null> {
  try {
    const t = (await settingsApi.getPublic())?.map_tiles;
    if (typeof t?.url !== 'string' || typeof t.attribution !== 'string') return null;
    return { url: t.url, attribution: t.attribution.replace(/[&<>"']/g, (c: string) => ESC[c]) };
  } catch {
    return null;
  }
}
