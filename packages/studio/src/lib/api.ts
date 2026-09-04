import { ENGINE_URL } from './config.js';

/**
 * The unit the Studio is standing in.
 *
 * The engine has read `x-tenant-slug` off the request since tenancy shipped, and
 * this client never sent it — so with hierarchical units now in the product,
 * there was no way for a person to see which unit they were in, let alone move
 * between them. The value lives in `localStorage` because it is a per-browser
 * choice, not an account setting: the same administrator may want one tab on the
 * county office and another on a district.
 *
 * Absent, the engine falls back to its own resolution, which is the behaviour
 * every install had before this existed.
 */
const TENANT_KEY = 'zveltio.tenantSlug';

export function currentTenantSlug(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage?.getItem(TENANT_KEY) || null;
  } catch {
    return null; // private mode
  }
}

export function setCurrentTenantSlug(slug: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (slug) window.localStorage.setItem(TENANT_KEY, slug);
    else window.localStorage.removeItem(TENANT_KEY);
  } catch {
    // nothing to do — the header simply will not be sent
  }
}

function tenantHeader(): Record<string, string> {
  const slug = currentTenantSlug();
  return slug ? { 'x-tenant-slug': slug } : {};
}

class ApiClient {
  private base: string;

  constructor(base: string) {
    this.base = base;
  }

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  private async request<T>(method: string, path: string, body?: any): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      credentials: 'include',
      headers: {
        ...tenantHeader(),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      // Unified error envelope (H-13): prefer problem+json `detail`/`title`,
      // keep tolerant fallback for legacy `{ error }` bodies during the beta.
      const err = await res.json().catch(() => ({}));
      const message =
        err.detail || err.title || err.error || err.message || `Request failed: ${res.status}`;
      const e = new Error(message) as Error & {
        code?: string;
        status?: number;
        traceId?: string;
        resource?: string;
        confidential?: boolean;
        canGrant?: Array<{ name: string }>;
      };
      e.code = err.code;
      e.status = res.status;
      e.traceId = err.traceId;
      // A refusal carries what the person needs to act: which resource, whether
      // it is confidential, and who can grant it. `detail` above is the
      // engine's English fallback for logs and curl; the UI renders these
      // fields translated (see `denialMessage`).
      if (err.code === 'permission_required') {
        e.resource = err.resource;
        e.confidential = err.confidential;
        e.canGrant = Array.isArray(err.can_grant) ? err.can_grant : [];
      }
      throw e;
    }

    return res.json();
  }

  /**
   * Low-level fetch wrapper for callers that need the Response object
   * itself (streaming downloads, non-JSON bodies, manual status handling).
   * Adds the engine base URL and credentials so callers don't have to
   * remember to set them. Use the typed `.get/.post/.put/.patch/.delete`
   * helpers for the common JSON-in/JSON-out flow.
   */
  fetch(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.base}${path}`, {
      credentials: 'include',
      ...init,
      headers: { ...tenantHeader(), ...(init.headers ?? {}) },
    });
  }

  get<T>(path: string) {
    return this.request<T>('GET', path);
  }
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  post<T>(path: string, body?: any) {
    return this.request<T>('POST', path, body);
  }
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  put<T>(path: string, body: any) {
    return this.request<T>('PUT', path, body);
  }
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  patch<T>(path: string, body: any) {
    return this.request<T>('PATCH', path, body);
  }
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  delete<T>(path: string, body?: any) {
    return this.request<T>('DELETE', path, body);
  }
}

export const api = new ApiClient(ENGINE_URL);

// Short-lived in-memory cache to prevent duplicate requests when switching tabs.
// collections/list and field-types rarely change — 30s TTL is safe.
interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
const _cache = new Map<string, CacheEntry<any>>();
const TTL = 30_000;

function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = _cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.data);
  return fn().then((data) => {
    _cache.set(key, { data, expiresAt: Date.now() + TTL });
    return data;
  });
}

export function invalidateCollectionsCache() {
  _cache.delete('collections:list');
  _cache.delete('collections:field-types');
}

// Typed helpers
export const collectionsApi = {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  list: () => cached('collections:list', () => api.get<{ collections: any[] }>('/api/collections')),
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  get: (name: string) => api.get<{ collection: any }>(`/api/collections/${name}`),
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  create: (data: any) =>
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    api.post<{ collection: any; job_id: string }>('/api/collections', data).then((r) => {
      invalidateCollectionsCache();
      return r;
    }),
  delete: (name: string) =>
    api.delete(`/api/collections/${name}`).then((r) => {
      invalidateCollectionsCache();
      return r;
    }),
  fieldTypes: () =>
    cached('collections:field-types', () =>
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      api.get<{ field_types: any[] }>('/api/collections/field-types'),
    ),
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  jobStatus: (jobId: string) => api.get<{ job: any }>(`/api/collections/jobs/${jobId}`),
};

/**
 * Query parameters as callers actually write them.
 *
 * `Record<string, string>` was the declared type while every paging call site
 * passed `{ limit: 25, offset: 0 }` — numbers. It worked, because
 * `URLSearchParams` coerces, and it was a type error nobody could see: the
 * Studio's `typecheck` is `tsc`, which does not read `.svelte` files at all.
 */
export type QueryParams = Record<string, string | number | boolean>;

function toQueryString(params: QueryParams): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) out.set(k, String(v));
  return out.toString();
}

export const dataApi = {
  list: (collection: string, params?: QueryParams) => {
    const qs = params ? `?${toQueryString(params)}` : '';
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    return api.get<{ records: any[]; pagination: any }>(`/api/data/${collection}${qs}`);
  },
  // Note: GET/POST/PATCH return the record directly (no { record: ... } wrapper)
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  get: (collection: string, id: string) => api.get<any>(`/api/data/${collection}/${id}`),
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  create: (collection: string, data: any) => api.post<any>(`/api/data/${collection}`, data),
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  update: (collection: string, id: string, data: any) =>
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    api.patch<any>(`/api/data/${collection}/${id}`, data),
  delete: (collection: string, id: string) => api.delete(`/api/data/${collection}/${id}`),
  bulkDelete: (collection: string, ids: string[]) =>
    api.delete<{ deleted: number }>(`/api/data/${collection}/bulk`, { ids }),
};

export const usersApi = {
  list: async (params?: QueryParams) => {
    const qs = params ? `?${toQueryString(params)}` : '';
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const data = await api.get<{ users: any[]; pagination: any }>(`/api/users${qs}`);
    return data.users || [];
  },
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  get: (id: string) => api.get<{ user: any }>(`/api/users/${id}`),
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  invite: (data: any) => api.post<{ user: any }>('/api/users/invite', data),
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  update: (id: string, data: any) => api.patch<{ user: any }>(`/api/users/${id}`, data),
  delete: (id: string) => api.delete(`/api/users/${id}`),
};

export const settingsApi = {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  getAll: () => api.get<Record<string, any>>('/api/settings'),
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  getPublic: () => api.get<Record<string, any>>('/api/settings/public'),
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  update: (key: string, value: any) => api.put(`/api/settings/${key}`, { value }),
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  updateBulk: (data: Record<string, any>) => api.patch('/api/settings/bulk', data),
};

export const webhooksApi = {
  list: async () => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const data = await api.get<{ webhooks: any[] }>('/api/webhooks');
    return data.webhooks || [];
  },
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  get: (id: string) => api.get<{ webhook: any }>(`/api/webhooks/${id}`),
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  create: (data: any) => api.post<{ webhook: any }>('/api/webhooks', data),
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  update: (id: string, data: any) => api.patch<{ webhook: any }>(`/api/webhooks/${id}`, data),
  delete: (id: string) => api.delete(`/api/webhooks/${id}`),
  test: (id: string) => api.post(`/api/webhooks/${id}/test`),
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  deliveries: (id: string) => api.get<{ deliveries: any[] }>(`/api/webhooks/${id}/deliveries`),
};

export const importApi = {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  jobs: () => api.get<{ jobs: any[] }>('/ext/data/import/jobs'),
};

/**
 * `zonesApi` and `viewsApi` were here.
 *
 * Zones became SITES and views became `collection_list` BLOCKS when
 * content/portals and content/page-builder merged into content/pages, and the
 * engine stopped mounting `/api/zones` and `/api/views` with them. Both helpers
 * outlived their routes: every method pointed at a 404, and nothing in the
 * Studio called either — the intranet and the client portal reach
 * `/ext/content/pages/sites/...` directly.
 *
 * Deleted rather than repointed. A repointed helper with no callers is the same
 * dead code with a working URL.
 */
