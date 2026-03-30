/**
 * generate-types.ts
 *
 * Programmatic type generator for Zveltio collections.
 * Fetches collection schemas from a running Zveltio engine and generates
 * TypeScript interface declarations with full type information.
 *
 * Usage (programmatic):
 *   import { generateTypes } from '@zveltio/sdk/generate-types';
 *   const dts = await generateTypes({ url: 'http://localhost:3000', apiKey: 'sk-...' });
 *   await fs.writeFile('./types/zveltio.d.ts', dts);
 *
 * Usage (CLI):
 *   zveltio generate-types --output ./types/zveltio.d.ts
 *   zveltio types --output ./types/zveltio.d.ts
 */

// ── Field type → TypeScript type mapping ─────────────────────────────────────

const FIELD_TYPE_MAP: Record<string, string> = {
  text:         'string',
  textarea:     'string',
  richtext:     'string',
  markdown:     'string',
  email:        'string',
  url:          'string',
  password:     'string',
  slug:         'string',
  uuid:         'string',
  color:        'string',
  number:       'number',
  integer:      'number',
  decimal:      'number',
  float:        'number',
  currency:     'number',
  percentage:   'number',
  boolean:      'boolean',
  toggle:       'boolean',
  date:         'string',    // ISO 8601 date string
  datetime:     'string',    // ISO 8601 datetime string
  time:         'string',
  timestamp:    'string',
  json:         'Record<string, unknown>',
  jsonb:        'Record<string, unknown>',
  object:       'Record<string, unknown>',
  array:        'unknown[]',
  tags:         'string[]',
  select:       'string',
  multiselect:  'string[]',
  relation:     'string',    // UUID of related record
  file:         'string',    // storage path
  image:        'string',    // storage path
  point:        '{ lat: number; lng: number }',
  geojson:      'GeoJSON.Geometry',
};

function fieldTypeToTs(fieldType: string): string {
  return FIELD_TYPE_MAP[fieldType.toLowerCase()] ?? 'unknown';
}

// ── Type generation helpers ───────────────────────────────────────────────────

interface CollectionField {
  name: string;
  type: string;
  required?: boolean;
  description?: string;
}

interface CollectionSchema {
  name: string;
  display_name?: string;
  description?: string;
  fields: CollectionField[];
}

/**
 * Converts a collection name (snake_case) to a PascalCase interface name.
 * Examples: "my_orders" → "MyOrders", "products" → "Products"
 */
function toPascalCase(name: string): string {
  return name
    .split(/[_\s-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('');
}

function generateCollectionInterface(col: CollectionSchema): string {
  const interfaceName = toPascalCase(col.name) + 'Collection';
  const fields = col.fields ?? [];

  const lines: string[] = [];

  if (col.description) {
    lines.push(`/** ${col.description} */`);
  }

  lines.push(`export interface ${interfaceName} {`);
  lines.push(`  /** Internal record ID (UUID) */`);
  lines.push(`  id: string;`);

  for (const field of fields) {
    if (field.description) {
      lines.push(`  /** ${field.description} */`);
    }
    const tsType = fieldTypeToTs(field.type);
    const optional = field.required ? '' : '?';
    lines.push(`  ${field.name}${optional}: ${tsType};`);
  }

  lines.push(`  /** ISO 8601 creation timestamp */`);
  lines.push(`  created_at: string;`);
  lines.push(`  /** ISO 8601 last-updated timestamp */`);
  lines.push(`  updated_at: string;`);
  lines.push(`}`);

  return lines.join('\n');
}

function generateIndexInterface(collections: CollectionSchema[]): string {
  const lines: string[] = [];
  lines.push(`/** Index of all Zveltio collections — use with \`ZveltioClient<ZveltioCollections>\` */`);
  lines.push(`export interface ZveltioCollections {`);
  for (const col of collections) {
    const interfaceName = toPascalCase(col.name) + 'Collection';
    const comment = col.display_name || col.name;
    lines.push(`  /** ${comment} */`);
    lines.push(`  ${col.name}: ${interfaceName};`);
  }
  lines.push(`}`);
  return lines.join('\n');
}

// ── Main generator ────────────────────────────────────────────────────────────

export interface GenerateTypesOptions {
  /** Zveltio engine URL (default: http://localhost:3000) */
  url?: string;
  /** API key for authentication */
  apiKey?: string;
  /** Only generate types for this collection */
  collection?: string;
}

/**
 * Generates TypeScript declarations for all (or one) Zveltio collection(s).
 *
 * Returns the `.d.ts` file content as a string. The caller is responsible for
 * writing it to disk.
 *
 * The engine endpoint `/api/admin/types` is used when available (returns
 * pre-generated TS from the server's field-type registry). If the endpoint
 * fails or is unavailable this function falls back to generating types from
 * the collection schema returned by `/api/collections`.
 */
export async function generateTypes(options: GenerateTypesOptions = {}): Promise<string> {
  const engineUrl = (options.url ?? process.env.ZVELTIO_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  const apiKey    = options.apiKey ?? process.env.ZVELTIO_API_KEY ?? '';
  const headers: Record<string, string> = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  // ── Try fast path: engine pre-generates types ────────────────────────────
  try {
    const path = options.collection
      ? `/api/admin/types/${encodeURIComponent(options.collection)}`
      : '/api/admin/types';

    const res = await fetch(`${engineUrl}${path}`, { headers });
    if (res.ok) {
      return await res.text();
    }
    // Fall through to manual generation on 404/401/500
    if (res.status !== 404) {
      console.warn(`[generate-types] Engine /api/admin/types returned ${res.status}, falling back to manual generation.`);
    }
  } catch {
    // Engine unreachable or endpoint absent — use fallback
  }

  // ── Fallback: fetch schema and generate types locally ────────────────────
  const collectionsUrl = options.collection
    ? `${engineUrl}/api/collections/${encodeURIComponent(options.collection)}`
    : `${engineUrl}/api/collections`;

  const res = await fetch(collectionsUrl, { headers });
  if (!res.ok) {
    throw new Error(`Failed to fetch collections from ${collectionsUrl}: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as { collections?: CollectionSchema[]; collection?: CollectionSchema };

  const collections: CollectionSchema[] = Array.isArray(data.collections)
    ? data.collections.filter((c: any) => !c.is_system)
    : data.collection
      ? [data.collection]
      : [];

  const header = `// Auto-generated by Zveltio\n// Do not edit manually — run: zveltio generate-types\n// Generated: ${new Date().toISOString()}\n`;
  const interfaces = collections.map(generateCollectionInterface).join('\n\n');
  const indexType  = options.collection ? '' : '\n\n' + generateIndexInterface(collections);

  return `${header}\n${interfaces}${indexType}\n`;
}
