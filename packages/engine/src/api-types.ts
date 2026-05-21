/**
 * Type-only API contract for `@zveltio/sdk/rpc` consumers.
 *
 * `ZveltioApi` is a Hono app fixture whose `typeof` describes the engine's
 * public HTTP surface — paths, methods, request/response payload shapes.
 * The SDK's `createRpcClient<ZveltioApi>(opts)` uses this type to generate
 * a typed proxy: paths autocomplete, payloads tsc-check, responses are
 * typed.
 *
 * Drift risk + remediation
 * ------------------------
 * This file is a TYPE FIXTURE, not the actual runtime routes. The runtime
 * lives in `routes/data.ts`, `routes/collections.ts`, etc. The two must
 * stay in sync — drift means clients get types that lie about the wire
 * shape.
 *
 * Mitigation strategies, in order of strength:
 *   1. **CI lint** — a future wave will run an OpenAPI-extraction job
 *      against the live engine and diff against this file. Drift = CI red.
 *   2. **Refactor the runtime to USE the chained builder** so
 *      `ZveltioApi = typeof dataRoutes` directly. Eliminates drift at the
 *      source. ~2 days of mechanical rewrite across 30+ route modules.
 *   3. **Manual review** (today) — every PR that touches `routes/` must
 *      keep this file in sync. CODEOWNERS for this file enforces a
 *      reviewer.
 *
 * What's included today
 * --------------------------------
 * - `/api/data/*`        — CRUD on user collections
 * - `/api/collections/*` — collection management + async DDL job polling
 * - `/api/users/*`       — admin user management
 * - `/api/me`            — current-session user
 * - `/api/health`        — minimal status check
 *
 * What's NOT yet included
 * -----------------------
 *   `/api/auth/*` (passes through better-auth — out of fixture scope),
 *   `/api/admin/*`, `/api/storage/*`, `/api/webhooks/*`, `/api/rpc/*`,
 *   `/api/ext/*` (extension-contributed, not core), `/api/marketplace/*`,
 *   `/api/notifications/*`, `/api/realtime/*`, `/api/views/*`,
 *   `/api/zones/*`, `/api/api-keys/*`, `/api/revisions/*`, etc.
 *
 * Each can be added one block at a time without breaking the existing
 * typed routes. The pattern is: define the response interface, declare
 * a mini-Hono builder with `.method(path, c => c.json<Type>(...))`,
 * mount it on `_apiRoutes` via `.route('/path', _builder)`.
 *
 * Drift mitigation today
 * ----------------------
 * Contract tests in `tests/unit/api-types-contract.test.ts` verify that
 * the fixture's promised paths exist at runtime by walking
 * `routes/index.ts`'s `app.route(...)` calls. CI catches stale fixtures
 * before they ship to clients.
 */

import { Hono } from 'hono';

// ── Shared payload types ────────────────────────────────────────────────────

/**
 * Generic record. Most collections have arbitrary user-defined fields, so
 * we keep this loose at the type level. Extensions that opt into S4-02's
 * typed `ctx.db` get strict types via their own DB generic.
 */
export type DataRecord = Record<string, unknown>;

/** List query response. Mirrors `routes/data.ts:dataRoutes` GET handler. */
export interface ListResponse {
  records: DataRecord[];
  /** Total matching the filter, ignoring pagination. */
  total: number;
  /** Cursor for keyset pagination; null when no more pages. */
  nextCursor?: string | null;
}

/** Single-record GET / PUT / PATCH response. */
export interface SingleResponse {
  record: DataRecord;
}

/** POST response — server-assigned `id` + the persisted row. */
export interface CreateResponse {
  record: DataRecord & { id: string };
}

/** DELETE response. */
export interface DeleteResponse {
  ok: true;
  id: string;
}

/** 4xx error envelope returned by the data layer. */
export interface ApiError {
  error: string;
  code?: string;
  /** Field-level validation messages, when applicable. */
  fields?: Record<string, string>;
}

// ── Collections ─────────────────────────────────────────────────────────────

export interface Collection {
  id: string;
  name: string;
  display_name?: string;
  description?: string;
  is_managed?: boolean;
  is_system?: boolean;
  fields?: Array<{
    name: string;
    type: string;
    required?: boolean;
    [k: string]: unknown;
  }>;
  [k: string]: unknown;
}

export interface CollectionListResponse { collections: Collection[] }
export interface CollectionResponse { collection: Collection }
/** Async DDL — collection mutations return a job id that Studio polls. */
export interface DdlJobResponse { jobId: string }
export interface DdlJobStatusResponse {
  id: string;
  type: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'dlq';
  error: string | null;
  retry_count: number;
  max_retries: number;
}

// ── Users ───────────────────────────────────────────────────────────────────

export interface UserSummary {
  id: string;
  name: string | null;
  email: string;
  roles?: string[];
  created_at?: string;
}
export interface UserListResponse {
  users: UserSummary[];
  total: number;
}
export interface UserResponse { user: UserSummary }
export interface InviteUserBody {
  email: string;
  name?: string;
  role?: 'member' | 'manager' | 'admin';
}
export interface InviteUserResponse { ok: true; user: UserSummary }

// ── /api/me ─────────────────────────────────────────────────────────────────

export interface MeResponse {
  user: UserSummary;
  permissions?: Record<string, string[]>;
  tenants?: Array<{ id: string; name: string }>;
}

// ── /api/health ─────────────────────────────────────────────────────────────

export interface HealthResponse { status: 'ok' }

// ── /api/electric ───────────────────────────────────────────────────────────

export interface ElectricConfigResponse {
  enabled: boolean;
  electricUrl?: string;
  tokenTtlSeconds?: number;
  reason?: string;
}

export interface ElectricAuthResponse {
  token: string;
  expiresAt: number;
  electricUrl: string;
}

// ── /api/data fixture ───────────────────────────────────────────────────────
//
// Each `.get/.post/.put/.patch/.delete` here documents the actual route
// over in `routes/<file>.ts`. The Hono builder captures path + method + (via
// `c.json<T>()`) the response type — that's what `createRpcClient<Type>()`
// turns into client autocomplete.

const _dataRoutes = new Hono()
  .get('/:collection', (c) => c.json<ListResponse>({ records: [], total: 0 }))
  .post('/:collection', (c) => c.json<CreateResponse>({ record: { id: '' } }, 201))
  .get('/:collection/:id', (c) => c.json<SingleResponse>({ record: {} }))
  .put('/:collection/:id', (c) => c.json<SingleResponse>({ record: {} }))
  .patch('/:collection/:id', (c) => c.json<SingleResponse>({ record: {} }))
  .delete('/:collection/:id', (c) => c.json<DeleteResponse>({ ok: true, id: '' }));

// ── /api/collections ────────────────────────────────────────────────────────

const _collectionsRoutes = new Hono()
  .get('/', (c) => c.json<CollectionListResponse>({ collections: [] }))
  .post('/', (c) => c.json<DdlJobResponse>({ jobId: '' }, 202))
  .get('/:name', (c) => c.json<CollectionResponse>({ collection: { id: '', name: '' } }))
  .patch('/:name', (c) => c.json<CollectionResponse>({ collection: { id: '', name: '' } }))
  .delete('/:name', (c) => c.json<DdlJobResponse>({ jobId: '' }, 202))
  .get('/:name/jobs/:jobId', (c) => c.json<DdlJobStatusResponse>({
    id: '', type: '', status: 'pending', error: null, retry_count: 0, max_retries: 3,
  }))
  .post('/:name/fields', (c) => c.json<DdlJobResponse>({ jobId: '' }, 202))
  .delete('/:name/fields/:fieldName', (c) => c.json<DdlJobResponse>({ jobId: '' }, 202));

// ── /api/users ──────────────────────────────────────────────────────────────

const _usersRoutes = new Hono()
  .get('/', (c) => c.json<UserListResponse>({ users: [], total: 0 }))
  .post('/invite', (c) => c.json<InviteUserResponse>({ ok: true, user: { id: '', name: null, email: '' } }, 201))
  .get('/:id', (c) => c.json<UserResponse>({ user: { id: '', name: null, email: '' } }))
  .patch('/:id', (c) => c.json<UserResponse>({ user: { id: '', name: null, email: '' } }))
  .delete('/:id', (c) => c.json<DeleteResponse>({ ok: true, id: '' }));

// ── /api/me ─────────────────────────────────────────────────────────────────

const _meRoutes = new Hono()
  .get('/', (c) => c.json<MeResponse>({ user: { id: '', name: null, email: '' } }));

// ── /api/health + version ───────────────────────────────────────────────────

const _healthRoutes = new Hono()
  .get('/', (c) => c.json<HealthResponse>({ status: 'ok' }));

// ── /api/electric ───────────────────────────────────────────────────────────

const _electricRoutes = new Hono()
  .get('/config', (c) => c.json<ElectricConfigResponse>({ enabled: false }))
  .post('/auth', (c) => c.json<ElectricAuthResponse>({
    token: '', expiresAt: 0, electricUrl: '',
  }));

// ── Engine root fixture ─────────────────────────────────────────────────────

const _apiRoutes = new Hono()
  .route('/api/data', _dataRoutes)
  .route('/api/collections', _collectionsRoutes)
  .route('/api/users', _usersRoutes)
  .route('/api/me', _meRoutes)
  .route('/api/health', _healthRoutes)
  .route('/api/electric', _electricRoutes);

/**
 * Public type the SDK binds against:
 *
 *   import { createRpcClient } from '@zveltio/sdk/rpc';
 *   import type { ZveltioApi } from '@zveltio/engine/api-types';
 *
 *   const client = createRpcClient<ZveltioApi>({ baseUrl: 'http://...' });
 *   const res = await client.api.data[':collection'].$post({
 *     param: { collection: 'contacts' },
 *     json: { email: 'a@b.com' },
 *   });
 *
 * Stable contract — bumping the SDK's major version is required to remove
 * or rename anything mounted here. Adding routes is non-breaking.
 */
export type ZveltioApi = typeof _apiRoutes;
