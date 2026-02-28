/**
 * Virtual Collection Adapter
 *
 * Proxies CRUD operations to an external API instead of querying PostgreSQL.
 * The calling route sees a uniform interface regardless of data source.
 */

export interface VirtualConfig {
  source_url: string;
  auth_type: 'none' | 'bearer' | 'api_key' | 'basic';
  auth_value?: string;
  /** zveltio_field_name → external_field_name */
  field_mapping: Record<string, string>;
  /** JSONPath-like selector for the items array, e.g. "$.data.items" or "$.results" */
  list_path: string;
  /** Field used as the record id, e.g. "id" */
  id_field: string;
}

export interface VirtualListResult {
  data: any[];
  total: number;
}

function buildAuthHeaders(config: VirtualConfig): Record<string, string> {
  if (config.auth_type === 'bearer' && config.auth_value) {
    return { Authorization: `Bearer ${config.auth_value}` };
  }
  if (config.auth_type === 'api_key' && config.auth_value) {
    return { 'X-API-Key': config.auth_value };
  }
  if (config.auth_type === 'basic' && config.auth_value) {
    return { Authorization: `Basic ${btoa(config.auth_value)}` };
  }
  return {};
}

/** Extract a nested value using a simple dot-path selector (e.g. "$.data.items"). */
function extractByPath(data: any, path: string): any[] {
  const parts = path.replace(/^\$\.?/, '').split('.').filter(Boolean);
  let current: any = data;
  for (const part of parts) {
    if (current == null) return [];
    current = current[part];
  }
  return Array.isArray(current) ? current : current != null ? [current] : [];
}

/** Remap external field names to Zveltio field names using field_mapping. */
function mapToZveltio(item: any, fieldMapping: Record<string, string>): any {
  if (!fieldMapping || Object.keys(fieldMapping).length === 0) return item;
  const result: Record<string, any> = {};
  // Copy all fields first
  Object.assign(result, item);
  // Apply mapping: zveltio_field = item[external_field]
  for (const [zveltioField, externalField] of Object.entries(fieldMapping)) {
    if (externalField in item) {
      result[zveltioField] = item[externalField];
      if (zveltioField !== externalField) delete result[externalField];
    }
  }
  return result;
}

/** Remap Zveltio field names back to external field names for write operations. */
function mapToExternal(item: any, fieldMapping: Record<string, string>): any {
  if (!fieldMapping || Object.keys(fieldMapping).length === 0) return item;
  const reversed: Record<string, string> = Object.fromEntries(
    Object.entries(fieldMapping).map(([z, e]) => [z, e]),
  );
  const result: Record<string, any> = {};
  Object.assign(result, item);
  for (const [zveltioField, externalField] of Object.entries(reversed)) {
    if (zveltioField in result && zveltioField !== externalField) {
      result[externalField] = result[zveltioField];
      delete result[zveltioField];
    }
  }
  return result;
}

export async function virtualList(
  config: VirtualConfig,
  params: { page?: number; limit?: number; search?: string } = {},
): Promise<VirtualListResult> {
  const headers = { 'Content-Type': 'application/json', ...buildAuthHeaders(config) };
  const url = new URL(config.source_url);
  if (params.page) url.searchParams.set('page', String(params.page));
  if (params.limit) url.searchParams.set('limit', String(params.limit));
  if (params.search) url.searchParams.set('search', params.search);

  const response = await fetch(url.toString(), { headers });
  if (!response.ok) throw new Error(`Virtual source returned ${response.status}: ${await response.text()}`);

  const json = await response.json();
  const listPath = config.list_path || '$.data';
  const items = extractByPath(json, listPath);
  const data = items.map((item) => mapToZveltio(item, config.field_mapping));
  const total: number = json.total ?? json.count ?? json.meta?.total ?? data.length;

  return { data, total };
}

export async function virtualGetOne(config: VirtualConfig, id: string): Promise<any | null> {
  const headers = { 'Content-Type': 'application/json', ...buildAuthHeaders(config) };
  const url = `${config.source_url.replace(/\/$/, '')}/${encodeURIComponent(id)}`;

  const response = await fetch(url, { headers });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Virtual source returned ${response.status}: ${await response.text()}`);

  const item = await response.json();
  return mapToZveltio(item, config.field_mapping);
}

export async function virtualCreate(config: VirtualConfig, body: any): Promise<any> {
  const headers = { 'Content-Type': 'application/json', ...buildAuthHeaders(config) };
  const externalBody = mapToExternal(body, config.field_mapping);

  const response = await fetch(config.source_url, {
    method: 'POST',
    headers,
    body: JSON.stringify(externalBody),
  });
  if (!response.ok) throw new Error(`Virtual source returned ${response.status}: ${await response.text()}`);

  const item = await response.json();
  return mapToZveltio(item, config.field_mapping);
}

export async function virtualUpdate(config: VirtualConfig, id: string, body: any): Promise<any> {
  const headers = { 'Content-Type': 'application/json', ...buildAuthHeaders(config) };
  const url = `${config.source_url.replace(/\/$/, '')}/${encodeURIComponent(id)}`;
  const externalBody = mapToExternal(body, config.field_mapping);

  const response = await fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(externalBody),
  });
  if (!response.ok) throw new Error(`Virtual source returned ${response.status}: ${await response.text()}`);

  const item = await response.json();
  return mapToZveltio(item, config.field_mapping);
}

export async function virtualDelete(config: VirtualConfig, id: string): Promise<void> {
  const headers = { 'Content-Type': 'application/json', ...buildAuthHeaders(config) };
  const url = `${config.source_url.replace(/\/$/, '')}/${encodeURIComponent(id)}`;

  const response = await fetch(url, { method: 'DELETE', headers });
  if (response.status === 404 || response.status === 204) return;
  if (!response.ok) throw new Error(`Virtual source returned ${response.status}: ${await response.text()}`);
}
