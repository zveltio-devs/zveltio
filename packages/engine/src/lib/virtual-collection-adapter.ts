/**
 * Virtual Collection Adapter
 *
 * Proxies CRUD operations to an external API instead of querying PostgreSQL.
 * The calling route sees a uniform interface regardless of data source.
 *
 * REGULA: Niciodată nu aduci toate datele de la API extern și filtrezi în memorie.
 * Adaptorul traduce query AST → parametri URL specifici API-ului extern.
 * Dacă API-ul nu suportă un operator, aruncă eroare clară.
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

  // ── Query Translation Config (optional, enables full filter translation) ──
  /** List endpoint path relative to source_url. Defaults to '/'. */
  list_endpoint?: string;
  /** Single-item endpoint with :id placeholder. Defaults to '/:id'. */
  get_endpoint?: string;
  /**
   * Operators this API supports. If defined, unsupported operators throw an error
   * instead of silently being ignored.
   * Supported values: 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'in' | 'like' | 'search'
   */
  supported_operators?: string[];
  /** How the external API handles pagination. Defaults to 'page'. */
  pagination_style?: 'offset' | 'page' | 'cursor';
  /** Maximum page size the external API accepts. Defaults to 100. */
  max_page_size?: number;
}

export interface VirtualQuery {
  filters?: Array<{ field: string; op: string; value: any }>;
  sort?: { field: string; direction: 'asc' | 'desc' };
  page: number;
  limit: number;
  search?: string;
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
  Object.assign(result, item);
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
  const result: Record<string, any> = {};
  Object.assign(result, item);
  for (const [zveltioField, externalField] of Object.entries(fieldMapping)) {
    if (zveltioField in result && zveltioField !== externalField) {
      result[externalField] = result[zveltioField];
      delete result[zveltioField];
    }
  }
  return result;
}

/**
 * Traduce un VirtualQuery în parametri URL pentru API-ul extern.
 * ARUNCĂ EROARE dacă se cere un operator nesuportat și supported_operators e definit.
 * NU face fetch-all — trimite parametrii direct la API.
 */
export function translateQuery(config: VirtualConfig, query: VirtualQuery): string {
  const params = new URLSearchParams();
  const supportedOps = config.supported_operators;
  const paginationStyle = config.pagination_style ?? 'page';
  const maxPageSize = config.max_page_size ?? 100;

  // Translate filters
  for (const filter of query.filters ?? []) {
    if (supportedOps && !supportedOps.includes(filter.op)) {
      throw new Error(
        `Virtual source "${config.source_url}" does not support operator "${filter.op}" ` +
          `on field "${filter.field}". Supported operators: ${supportedOps.join(', ')}`,
      );
    }

    // Map field name: zveltio field → external field
    const apiField = config.field_mapping?.[filter.field] ?? filter.field;

    switch (filter.op) {
      case 'eq':
        params.append(apiField, String(filter.value));
        break;
      case 'neq':
        params.append(`${apiField}[neq]`, String(filter.value));
        break;
      case 'gt':
        params.append(`${apiField}[gt]`, String(filter.value));
        break;
      case 'lt':
        params.append(`${apiField}[lt]`, String(filter.value));
        break;
      case 'gte':
        params.append(`${apiField}[gte]`, String(filter.value));
        break;
      case 'lte':
        params.append(`${apiField}[lte]`, String(filter.value));
        break;
      case 'in':
        params.append(
          `${apiField}[in]`,
          Array.isArray(filter.value) ? filter.value.join(',') : String(filter.value),
        );
        break;
      case 'like':
      case 'ilike':
        params.append(`${apiField}[like]`, String(filter.value));
        break;
      default:
        // Unknown operator — pass as-is if no supported_operators constraint
        params.append(`${apiField}[${filter.op}]`, String(filter.value));
    }
  }

  // Search
  if (query.search) {
    params.append('search', query.search);
  }

  // Pagination
  const effectiveLimit = Math.min(query.limit, maxPageSize);
  if (paginationStyle === 'offset') {
    params.append('offset', String((query.page - 1) * effectiveLimit));
    params.append('limit', String(effectiveLimit));
  } else {
    // page-based (default)
    params.append('page', String(query.page));
    params.append('per_page', String(effectiveLimit));
  }

  // Sort
  if (query.sort) {
    const apiField = config.field_mapping?.[query.sort.field] ?? query.sort.field;
    params.append('sort', `${query.sort.direction === 'desc' ? '-' : ''}${apiField}`);
  }

  return params.toString();
}

/**
 * Fetch list de la Virtual Source — NU face fetch-all.
 * Traduce query-ul (filtre, paginare, sort) direct în URL params și îl trimite la API.
 */
export async function virtualList(
  config: VirtualConfig,
  query: VirtualQuery,
): Promise<VirtualListResult> {
  const headers = { Accept: 'application/json', ...buildAuthHeaders(config) };

  // Build URL with translated query
  const baseUrl = config.source_url.replace(/\/$/, '');
  const listPath = config.list_endpoint ?? '';
  const qs = translateQuery(config, query);
  const url = `${baseUrl}${listPath}${qs ? `?${qs}` : ''}`;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Virtual source returned ${response.status}: ${await response.text()}`);
  }

  const json = await response.json();
  const extractPath = config.list_path || '$.data';
  const items = extractByPath(json, extractPath);
  const data = items.map((item) => mapToZveltio(item, config.field_mapping));
  const total: number = json.total ?? json.count ?? json.meta?.total ?? data.length;

  return { data, total };
}

export async function virtualGetOne(config: VirtualConfig, id: string): Promise<any | null> {
  const headers = { Accept: 'application/json', ...buildAuthHeaders(config) };
  const baseUrl = config.source_url.replace(/\/$/, '');
  const getPath = (config.get_endpoint ?? '/:id').replace(':id', encodeURIComponent(id));
  const url = `${baseUrl}${getPath}`;

  const response = await fetch(url, { headers });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Virtual source returned ${response.status}: ${await response.text()}`);
  }

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
  if (!response.ok) {
    throw new Error(`Virtual source returned ${response.status}: ${await response.text()}`);
  }

  const item = await response.json();
  return mapToZveltio(item, config.field_mapping);
}

export async function virtualUpdate(config: VirtualConfig, id: string, body: any): Promise<any> {
  const headers = { 'Content-Type': 'application/json', ...buildAuthHeaders(config) };
  const baseUrl = config.source_url.replace(/\/$/, '');
  const getPath = (config.get_endpoint ?? '/:id').replace(':id', encodeURIComponent(id));
  const url = `${baseUrl}${getPath}`;
  const externalBody = mapToExternal(body, config.field_mapping);

  const response = await fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(externalBody),
  });
  if (!response.ok) {
    throw new Error(`Virtual source returned ${response.status}: ${await response.text()}`);
  }

  const item = await response.json();
  return mapToZveltio(item, config.field_mapping);
}

export async function virtualDelete(config: VirtualConfig, id: string): Promise<void> {
  const headers = { Accept: 'application/json', ...buildAuthHeaders(config) };
  const baseUrl = config.source_url.replace(/\/$/, '');
  const getPath = (config.get_endpoint ?? '/:id').replace(':id', encodeURIComponent(id));
  const url = `${baseUrl}${getPath}`;

  const response = await fetch(url, { method: 'DELETE', headers });
  if (response.status === 404 || response.status === 204) return;
  if (!response.ok) {
    throw new Error(`Virtual source returned ${response.status}: ${await response.text()}`);
  }
}
