/**
 * Unit coverage for the Virtual Collection Adapter — the layer that proxies
 * collection CRUD to an external HTTP API instead of PostgreSQL.
 *
 * translateQuery is a pure function (operator → URL-param translation) and is
 * tested directly. The virtual* functions issue real fetch()es, so we stub
 * globalThis.fetch with a recorder that captures the URL/method/headers/body
 * and returns a scripted Response. That exercises the full path: SSRF guard →
 * auth headers → URL build → response extraction → field remapping → errors.
 *
 * No DB and no network: validatePublicUrl is a pure string blocklist (no DNS),
 * so public-looking hosts like api.example.com pass without a lookup.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  translateQuery,
  type VirtualConfig,
  type VirtualQuery,
  virtualCreate,
  virtualDelete,
  virtualGetOne,
  virtualList,
  virtualUpdate,
} from '../../lib/virtual-collection-adapter.js';

const BASE = 'https://api.example.com';

function baseConfig(overrides: Partial<VirtualConfig> = {}): VirtualConfig {
  return {
    source_url: BASE,
    auth_type: 'none',
    field_mapping: {},
    list_path: '$.data',
    id_field: 'id',
    ...overrides,
  };
}

function baseQuery(overrides: Partial<VirtualQuery> = {}): VirtualQuery {
  return { page: 1, limit: 20, ...overrides };
}

/** Records the last fetch call and returns a scripted Response. */
interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

let lastCall: Recorded | null;
let originalFetch: typeof fetch;

function stubFetch(status: number, jsonBody: unknown, ok = status < 400): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    lastCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: (init?.body as string) ?? null,
    };
    return {
      ok,
      status,
      json: async () => jsonBody,
      text: async () => (typeof jsonBody === 'string' ? jsonBody : JSON.stringify(jsonBody)),
    } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  lastCall = null;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('translateQuery (pure)', () => {
  it('translates each supported operator to the API param shape', () => {
    const cfg = baseConfig();
    const qs = translateQuery(
      cfg,
      baseQuery({
        filters: [
          { field: 'a', op: 'eq', value: 1 },
          { field: 'b', op: 'neq', value: 2 },
          { field: 'c', op: 'gt', value: 3 },
          { field: 'd', op: 'lt', value: 4 },
          { field: 'e', op: 'gte', value: 5 },
          { field: 'f', op: 'lte', value: 6 },
          { field: 'g', op: 'in', value: [7, 8] },
          { field: 'h', op: 'like', value: 'x' },
          { field: 'i', op: 'ilike', value: 'y' },
        ],
      }),
    );
    const p = new URLSearchParams(qs);
    expect(p.get('a')).toBe('1');
    expect(p.get('b[neq]')).toBe('2');
    expect(p.get('c[gt]')).toBe('3');
    expect(p.get('d[lt]')).toBe('4');
    expect(p.get('e[gte]')).toBe('5');
    expect(p.get('f[lte]')).toBe('6');
    expect(p.get('g[in]')).toBe('7,8');
    expect(p.get('h[like]')).toBe('x');
    expect(p.get('i[like]')).toBe('y');
  });

  it('serializes a scalar `in` value without joining', () => {
    const qs = translateQuery(
      baseConfig(),
      baseQuery({ filters: [{ field: 'g', op: 'in', value: 9 }] }),
    );
    expect(new URLSearchParams(qs).get('g[in]')).toBe('9');
  });

  it('passes an unknown operator through as [op] when unconstrained', () => {
    const qs = translateQuery(
      baseConfig(),
      baseQuery({ filters: [{ field: 'a', op: 'weird', value: 'z' }] }),
    );
    expect(new URLSearchParams(qs).get('a[weird]')).toBe('z');
  });

  it('throws on an unsupported operator when supported_operators is defined', () => {
    const cfg = baseConfig({ supported_operators: ['eq', 'in'] });
    expect(() =>
      translateQuery(cfg, baseQuery({ filters: [{ field: 'a', op: 'gt', value: 1 }] })),
    ).toThrow(/does not support operator "gt"/);
  });

  it('maps zveltio field names to external names via field_mapping', () => {
    const cfg = baseConfig({ field_mapping: { title: 'name' } });
    const qs = translateQuery(
      cfg,
      baseQuery({ filters: [{ field: 'title', op: 'eq', value: 'hi' }] }),
    );
    expect(new URLSearchParams(qs).get('name')).toBe('hi');
  });

  it('adds a search param', () => {
    const qs = translateQuery(baseConfig(), baseQuery({ search: 'needle' }));
    expect(new URLSearchParams(qs).get('search')).toBe('needle');
  });

  it('emits page-based pagination by default and clamps to max_page_size', () => {
    const cfg = baseConfig({ max_page_size: 25 });
    const qs = translateQuery(cfg, baseQuery({ page: 3, limit: 500 }));
    const p = new URLSearchParams(qs);
    expect(p.get('page')).toBe('3');
    expect(p.get('per_page')).toBe('25');
  });

  it('emits offset-based pagination when configured', () => {
    const cfg = baseConfig({ pagination_style: 'offset', max_page_size: 10 });
    const qs = translateQuery(cfg, baseQuery({ page: 4, limit: 10 }));
    const p = new URLSearchParams(qs);
    expect(p.get('offset')).toBe('30'); // (4-1) * 10
    expect(p.get('limit')).toBe('10');
  });

  it('encodes sort direction as a -prefix for desc, mapped field name', () => {
    const cfg = baseConfig({ field_mapping: { created: 'created_at' } });
    const asc = new URLSearchParams(
      translateQuery(cfg, baseQuery({ sort: { field: 'created', direction: 'asc' } })),
    );
    const desc = new URLSearchParams(
      translateQuery(cfg, baseQuery({ sort: { field: 'created', direction: 'desc' } })),
    );
    expect(asc.get('sort')).toBe('created_at');
    expect(desc.get('sort')).toBe('-created_at');
  });
});

describe('virtualList', () => {
  it('extracts items via list_path, remaps fields, and derives total', async () => {
    stubFetch(200, { data: [{ ext_name: 'Ada', id: 1 }], total: 42 });
    const cfg = baseConfig({ list_path: '$.data', field_mapping: { name: 'ext_name' } });
    const res = await virtualList(cfg, baseQuery());
    expect(res.total).toBe(42);
    expect(res.data[0].name).toBe('Ada');
    expect(res.data[0].ext_name).toBeUndefined();
    expect(lastCall?.url.startsWith(`${BASE}?`)).toBe(true);
  });

  it('honors list_endpoint and falls back total to data length', async () => {
    stubFetch(200, { results: [{ id: 1 }, { id: 2 }] });
    const cfg = baseConfig({ list_endpoint: '/v2/items', list_path: '$.results' });
    const res = await virtualList(cfg, baseQuery());
    expect(res.total).toBe(2);
    expect(lastCall?.url.startsWith(`${BASE}/v2/items?`)).toBe(true);
  });

  it('throws when the external source is not ok', async () => {
    stubFetch(500, 'boom', false);
    await expect(virtualList(baseConfig(), baseQuery())).rejects.toThrow(/returned 500/);
  });

  it('rejects an internal/SSRF URL before fetching', async () => {
    stubFetch(200, { data: [] });
    const cfg = baseConfig({ source_url: 'http://127.0.0.1/admin' });
    await expect(virtualList(cfg, baseQuery())).rejects.toThrow(
      /internal\/private address blocked/,
    );
    expect(lastCall).toBeNull(); // never reached fetch
  });

  it('sends a bearer auth header', async () => {
    stubFetch(200, { data: [] });
    await virtualList(baseConfig({ auth_type: 'bearer', auth_value: 'tok123' }), baseQuery());
    expect(lastCall?.headers.Authorization).toBe('Bearer tok123');
  });
});

describe('virtualGetOne', () => {
  it('fetches /:id, remaps fields', async () => {
    stubFetch(200, { id: 7, ext_name: 'Bob' });
    const cfg = baseConfig({ field_mapping: { name: 'ext_name' } });
    const item = await virtualGetOne(cfg, '7');
    expect(item.name).toBe('Bob');
    expect(lastCall?.url).toBe(`${BASE}/7`);
  });

  it('returns null on 404', async () => {
    stubFetch(404, 'nope', false);
    expect(await virtualGetOne(baseConfig(), 'x')).toBeNull();
  });

  it('uses get_endpoint with :id substitution and url-encodes the id', async () => {
    stubFetch(200, { id: 'a/b' });
    await virtualGetOne(baseConfig({ get_endpoint: '/records/:id' }), 'a/b');
    expect(lastCall?.url).toBe(`${BASE}/records/a%2Fb`);
  });

  it('throws on a non-404 error status', async () => {
    stubFetch(503, 'down', false);
    await expect(virtualGetOne(baseConfig(), '1')).rejects.toThrow(/returned 503/);
  });
});

describe('virtualCreate', () => {
  it('POSTs external-mapped body and remaps the response', async () => {
    stubFetch(201, { id: 1, ext_name: 'Cy' });
    const cfg = baseConfig({
      auth_type: 'api_key',
      auth_value: 'k',
      field_mapping: { name: 'ext_name' },
    });
    const created = await virtualCreate(cfg, { name: 'Cy' });
    expect(created.name).toBe('Cy');
    expect(lastCall?.method).toBe('POST');
    expect(lastCall?.headers['X-API-Key']).toBe('k');
    expect(JSON.parse(lastCall?.body ?? '{}')).toEqual({ ext_name: 'Cy' });
  });

  it('throws when create fails', async () => {
    stubFetch(422, 'invalid', false);
    await expect(virtualCreate(baseConfig(), { a: 1 })).rejects.toThrow(/returned 422/);
  });
});

describe('virtualUpdate', () => {
  it('PATCHes /:id with a basic auth header and mapped body', async () => {
    stubFetch(200, { id: 3, ext_name: 'Dee' });
    const cfg = baseConfig({
      auth_type: 'basic',
      auth_value: 'u:p',
      field_mapping: { name: 'ext_name' },
    });
    const updated = await virtualUpdate(cfg, '3', { name: 'Dee' });
    expect(updated.name).toBe('Dee');
    expect(lastCall?.method).toBe('PATCH');
    expect(lastCall?.url).toBe(`${BASE}/3`);
    expect(lastCall?.headers.Authorization).toBe(`Basic ${btoa('u:p')}`);
    expect(JSON.parse(lastCall?.body ?? '{}')).toEqual({ ext_name: 'Dee' });
  });

  it('throws when update fails', async () => {
    stubFetch(400, 'bad', false);
    await expect(virtualUpdate(baseConfig(), '1', {})).rejects.toThrow(/returned 400/);
  });
});

describe('virtualDelete', () => {
  it('DELETEs /:id and resolves on 204', async () => {
    stubFetch(204, '', false);
    await virtualDelete(baseConfig(), '5');
    expect(lastCall?.method).toBe('DELETE');
    expect(lastCall?.url).toBe(`${BASE}/5`);
  });

  it('treats 404 as a successful no-op', async () => {
    stubFetch(404, '', false);
    await expect(virtualDelete(baseConfig(), 'gone')).resolves.toBeUndefined();
  });

  it('throws on a real delete error', async () => {
    stubFetch(500, 'err', false);
    await expect(virtualDelete(baseConfig(), '1')).rejects.toThrow(/returned 500/);
  });
});
