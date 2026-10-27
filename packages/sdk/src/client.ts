import { ZveltioApiError } from './errors.js';

/** The header a step-up token rides in (engine lib/step-up.ts). */
const STEP_UP_HEADER = 'X-Zveltio-Step-Up';

type SendInit = Omit<RequestInit, 'headers'> & { headers: Record<string, string> };

export interface ZveltioClientConfig {
  baseUrl: string;
  apiKey?: string;
  /**
   * A session token for a client with no cookie jar (native app, server): sent as
   * `Authorization: Bearer`, with cookies off. Giving this or `onSessionToken`
   * turns that mode on; a browser leaves both unset and keeps the httpOnly cookie.
   */
  sessionToken?: string;
  /**
   * Called with each token the engine issues (sign-in, a session it replaces) and
   * with `null` on logout: persist it here and pass it back as `sessionToken`.
   */
  onSessionToken?: (token: string | null) => void;
  /**
   * Called when the engine answers 403 `step_up_required` (a configuration change,
   * or an action that wants a fresh second factor). Confirm the user's passkey or
   * TOTP for `action` and resolve with the step-up token; the call is then sent
   * once more with it. Resolve `null` to give up: the 403 is thrown as before.
   */
  onStepUpRequired?: (action: string) => Promise<string | null>;
  headers?: Record<string, string>;
}

/** `GET /api/api-keys/self` — the key a client authenticates with, as the engine holds it. */
export interface ApiKeySelf {
  id: string;
  name: string;
  key_prefix: string;
  scopes: Array<{ collection: string; actions: string[] }>;
  tenant_id: string | null;
  expires_at: string | null;
  rls_bypass: boolean;
}

export interface ListParams {
  page?: number;
  limit?: number;
  sort?: string;
  order?: 'asc' | 'desc';
  search?: string;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  filter?: Record<string, any>;
  cursor?: string;
}

/**
 * What `GET /api/data/:collection` answers (`listRecords` in the engine). This
 * declared `{ data, total, page, limit }`, a shape the engine has never sent, so
 * every typed reader of `.data` got `undefined` — the sync manager's paged pull
 * among them, which applied no row at all.
 */
export interface ListResult<T> {
  records: T[];
  pagination: {
    /** Absent when the count was skipped. */
    total?: number;
    page: number;
    limit: number;
    pages?: number;
  };
  next_cursor?: string;
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
class CollectionRef<T extends Record<string, any>> {
  /** URL-encoded once, here: a record id is caller data (a slug, an email, a
   * composite key), and an unencoded `/`, `?` or `#` in one silently routes
   * the request somewhere else. */
  private readonly path: string;

  constructor(
    name: string,
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    private readonly client: ZveltioClient<any>,
  ) {
    this.path = `/api/data/${encodeURIComponent(name)}`;
  }

  list(params?: ListParams): Promise<ListResult<T>> {
    const qs = new URLSearchParams();
    if (params?.page) qs.set('page', String(params.page));
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.sort) qs.set('sort', params.sort);
    if (params?.order) qs.set('order', params.order);
    if (params?.search) qs.set('search', params.search);
    if (params?.filter) qs.set('filter', JSON.stringify(params.filter));
    if (params?.cursor) qs.set('cursor', params.cursor);
    const q = qs.toString();
    return this.client['request']('GET', `${this.path}${q ? `?${q}` : ''}`);
  }

  getMany(params?: ListParams): Promise<ListResult<T>> {
    return this.list(params);
  }

  get(id: string): Promise<T> {
    return this.client['request']('GET', `${this.path}/${encodeURIComponent(id)}`);
  }

  getOne(id: string): Promise<T> {
    return this.get(id);
  }

  create(data: Omit<T, 'id' | 'created_at' | 'updated_at'>): Promise<T> {
    return this.client['request']('POST', this.path, data);
  }

  update(id: string, data: Partial<Omit<T, 'id' | 'created_at' | 'updated_at'>>): Promise<T> {
    return this.client['request']('PATCH', `${this.path}/${encodeURIComponent(id)}`, data);
  }

  delete(id: string): Promise<{ success: boolean }> {
    return this.client['request']('DELETE', `${this.path}/${encodeURIComponent(id)}`);
  }
}

/**
 * ZveltioClient — generic over your schema type.
 *
 * Usage with generated types (run `zveltio generate-types` once):
 *
 *   import type { ZveltioSchema } from './zveltio-types';
 *   const client = createZveltioClient<ZveltioSchema>({ baseUrl: '...' });
 *   const { records } = await client.collection('products').list();
 *   //          ^-- typed as your Products interface
 *
 * Usage without types (untyped, same as before):
 *   const client = createZveltioClient({ baseUrl: '...' });
 */

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
export class ZveltioClient<Schema extends Record<string, any> = Record<string, any>> {
  private baseUrl: string;
  private headers: Record<string, string>;
  private bearer: boolean;
  private sessionToken: string | null;
  private onSessionToken?: (token: string | null) => void;
  private onStepUpRequired?: (action: string) => Promise<string | null>;

  constructor(config: ZveltioClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.headers = {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { 'X-API-Key': config.apiKey } : {}),
      ...config.headers,
    };
    this.bearer = config.sessionToken !== undefined || config.onSessionToken !== undefined;
    this.sessionToken = config.sessionToken ?? null;
    this.onSessionToken = config.onSessionToken;
    this.onStepUpRequired = config.onStepUpRequired;
  }

  /** Switch to bearer mode with `token` (or sign this client out of it with `null`). */
  setSessionToken(token: string | null): void {
    this.bearer = true;
    this.sessionToken = token;
    this.onSessionToken?.(token);
  }

  /** The token bearer mode sends; null in cookie mode or when signed out. */
  getSessionToken(): string | null {
    return this.sessionToken;
  }

  /** Every call goes through here: the bearer out, a newly issued token in. */
  private async send(path: string, init: SendInit) {
    const res = await this.sendOnce(path, init);
    if (res.status !== 403 || !this.onStepUpRequired) return this.checked(res);
    const err = await ZveltioApiError.fromResponse(res);
    if (err.code !== 'step_up_required') throw err;
    const action = (err.errors as { action?: unknown } | undefined)?.action;
    const token = typeof action === 'string' ? await this.onStepUpRequired(action) : null;
    if (!token) throw err;
    return this.checked(
      await this.sendOnce(path, {
        ...init,
        headers: { ...init.headers, [STEP_UP_HEADER]: token },
      }),
    );
  }

  private async checked(res: Response): Promise<Response> {
    if (!res.ok) throw await ZveltioApiError.fromResponse(res);
    return res;
  }

  private async sendOnce(path: string, init: SendInit) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers:
        this.bearer && this.sessionToken
          ? { ...init.headers, Authorization: `Bearer ${this.sessionToken}` }
          : init.headers,
      // A cookie jar beside the bearer would carry a session the bearer then overrides.
      credentials: this.bearer ? 'omit' : 'include',
    });
    const issued = this.bearer ? res.headers.get('set-auth-token') : null;
    if (issued && issued !== this.sessionToken) this.setSessionToken(issued);
    return res;
  }

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  private async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.send(path, {
      method,
      headers: this.headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  }

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  get<T = any>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  post<T = any>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  patch<T = any>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  delete<T = any>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  async upload<T = any>(path: string, formData: FormData): Promise<T> {
    const headers = { ...this.headers };
    delete headers['Content-Type'];
    const res = await this.send(path, { method: 'POST', headers, body: formData });
    return res.json();
  }

  /**
   * Returns a fully-typed collection reference.
   * If Schema is provided (via createZveltioClient<MySchema>()),
   * the return type reflects the collection's record shape.
   */
  collection<K extends keyof Schema & string>(name: K): CollectionRef<Schema[K]>;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  collection(name: string): CollectionRef<Record<string, any>>;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  collection(name: string): CollectionRef<any> {
    return new CollectionRef(name, this);
  }

  /** Auth helpers */
  readonly auth = {
    login: (email: string, password: string) =>
      this.request('POST', '/api/auth/sign-in/email', { email, password }),
    signup: (email: string, password: string, name: string) =>
      this.request('POST', '/api/auth/sign-up/email', { email, password, name }),
    logout: async () => {
      try {
        return await this.request('POST', '/api/auth/sign-out');
      } finally {
        if (this.bearer) this.setSessionToken(null);
      }
    },
    session: () => this.request('GET', '/api/auth/get-session'),
    /**
     * The API key this client was made with: its scopes, tenant, expiry and RLS
     * exemption — never the hash. 403 for a session, 401 for a key that no
     * longer authenticates.
     */
    apiKey: () => this.request<ApiKeySelf>('GET', '/api/api-keys/self'),
  } as const;

  /**
   * Storage helpers. A client made with `apiKey` needs a key holding the `$storage`
   * scope — `{ collection: '$storage', actions: ['read', 'create', 'delete'] }`; a
   * `*` collection does not include it, and the engine answers 403 without it.
   */
  readonly storage = {
    upload: (file: File, folder?: string) => {
      const fd = new FormData();
      fd.append('file', file);
      // The engine reads `folder_id`; a `folder` field is ignored and the file
      // lands in the root.
      if (folder) fd.append('folder_id', folder);
      return this.upload('/api/storage/upload', fd);
    },
    list: (folder?: string) =>
      this.get(`/api/storage${folder ? `?folder_id=${encodeURIComponent(folder)}` : ''}`),
    delete: (key: string) => this.delete(`/api/storage/${encodeURIComponent(key)}`),
  } as const;
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
export function createZveltioClient<Schema extends Record<string, any> = Record<string, any>>(
  config: ZveltioClientConfig,
): ZveltioClient<Schema> {
  return new ZveltioClient<Schema>(config);
}
