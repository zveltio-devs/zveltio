/**
 * The map tile server, chosen by the operator (ADR 0043).
 *
 * Every tile request carries the viewer's address to whoever serves it, so the
 * host is configuration, not a constant in seven components: front ends read it
 * from `GET /api/settings/public` (`map_tiles`). Unset: OpenStreetMap, as before.
 * `off`: no tiles; a map view draws its list of places only.
 */

export interface MapTiles {
  url: string;
  attribution: string;
}

const OSM: MapTiles = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '© OpenStreetMap contributors',
};

/** Leaflet fills these itself; any other `{name}` fails at draw time, in every viewer. */
const PLACEHOLDERS = new Set(['s', 'z', 'x', 'y', 'r']);

/** The tile server from `ZVELTIO_MAP_TILES` / `ZVELTIO_MAP_ATTRIBUTION`; throws on an unusable template. */
export function mapTiles(env: Record<string, string | undefined> = process.env): MapTiles | null {
  const raw = env.ZVELTIO_MAP_TILES?.trim();
  // Empty is unset: compose passes `${VAR:-}` through as ''.
  const attribution = env.ZVELTIO_MAP_ATTRIBUTION?.trim() || undefined;
  if (!raw) return attribution === undefined ? OSM : { url: OSM.url, attribution };
  if (raw.toLowerCase() === 'off') return null;
  const problem = templateProblem(raw);
  if (problem)
    throw new Error(
      `ZVELTIO_MAP_TILES=${JSON.stringify(raw)} ${problem}. Give an https:// URL template ` +
        'with {z}, {x} and {y} (optional {s}, {r}), or `off` for no map tiles.',
    );
  return { url: raw, attribution: attribution ?? '' };
}

function templateProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'is not a URL';
  }
  if (parsed.protocol !== 'https:') return 'is not https';
  for (const p of ['{z}', '{x}', '{y}']) if (!url.includes(p)) return `has no ${p}`;
  for (const [, name] of url.matchAll(/\{([^}]*)\}/g))
    if (!PLACEHOLDERS.has(name)) return `names {${name}}, which a map cannot fill`;
  return null;
}
