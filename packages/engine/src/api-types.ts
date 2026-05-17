/**
 * Type-only API contract for `@zveltio/sdk/rpc` consumers (S5-02).
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
 * ---------------------
 * - `POST/GET/PUT/PATCH/DELETE /api/data/:collection[/:id]`  (S5-02 MVP)
 *
 * What's NOT yet included
 * -----------------------
 *   `/api/collections/*`, `/api/users/*`, `/api/auth/*`, `/api/admin/*`,
 *   `/api/storage/*`, `/api/webhooks/*`, etc. They still work via plain
 *   `fetch` — they just don't get the typed RPC client experience yet.
 *   Each can be added one block at a time without breaking the existing
 *   typed routes.
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

// ── /api/data fixture ───────────────────────────────────────────────────────
//
// Each `.get/.post/.put/.patch/.delete` here documents the actual route
// over in `routes/data.ts`. The Hono builder captures path + method + (via
// `c.json<T>()`) the response type — that's what `createRpcClient<Type>()`
// turns into client autocomplete.

const _dataRoutes = new Hono()
  .get('/:collection', (c) => c.json<ListResponse>({ records: [], total: 0 }))
  .post('/:collection', (c) => c.json<CreateResponse>({ record: { id: '' } }, 201))
  .get('/:collection/:id', (c) => c.json<SingleResponse>({ record: {} }))
  .put('/:collection/:id', (c) => c.json<SingleResponse>({ record: {} }))
  .patch('/:collection/:id', (c) => c.json<SingleResponse>({ record: {} }))
  .delete('/:collection/:id', (c) => c.json<DeleteResponse>({ ok: true, id: '' }));

// ── Engine root fixture ─────────────────────────────────────────────────────
//
// As more route surfaces opt in to the typed client, mount them here.
//   const _apiRoutes = new Hono()
//     .route('/api/data', _dataRoutes)
//     .route('/api/collections', _collectionsRoutes)  // ← future wave
//     .route('/api/users', _usersRoutes)              // ← future wave

const _apiRoutes = new Hono()
  .route('/api/data', _dataRoutes);

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
