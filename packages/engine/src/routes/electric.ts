/**
 * Electric shapes, served through the engine's read gate.
 *
 *   GET /api/electric/v1/shape?collection=<name>&offset=…[&handle=…&live=true&cursor=…]
 *
 * Electric 1.x (HTTP Shape API) is reachable only from the engine and holds a
 * secret clients never see. The client names a collection and continues a
 * stream; the ENGINE decides everything that decides what is read — `table`,
 * `columns` and `where` — from the caller's Casbin `read`, tenant reach, row
 * rules and column permissions (lib/tenancy/electric-shape.ts). A client that
 * sends any of those, or `params`, `secret` or a subset query, is refused.
 *
 * A handle cannot widen a shape: Electric binds it to the definition, and a
 * handle sent with a different definition answers 409 `must-refetch` (measured
 * on 1.8.1). The definition is rebuilt on every request, so a revoked grant or
 * a changed rule takes effect at the client's next poll, as a resync.
 *
 * Runs outside the request transaction (TXN_SKIP_PREFIXES): a live request
 * long-polls for up to ~20 s, and holding a pooled connection for that is how
 * the engine stops at `c = DB_POOL_MAX`. Nothing here reads a policed table.
 *
 * Without ELECTRIC_URL + ELECTRIC_SECRET the route answers 503, and the SDK
 * falls back to the CRDT provider.
 */

import { Hono } from 'hono';
import type { Database } from '../db/index.js';
import {
  authenticate,
  type CollectionDef,
  checkAccess,
  DDLManager,
  readScope,
  withheldColumns,
} from '../lib/data/index.js';
import { problem } from '../lib/problem.js';
import { tenantId } from '../lib/route-db.js';
import { buildShapeDefinition, shapeSearchParams, shapeTenantReach } from '../lib/tenancy/index.js';

interface ElectricConfig {
  electricUrl: string;
  secret: string;
}

function readConfig(): ElectricConfig | null {
  const electricUrl = process.env.ELECTRIC_URL?.trim();
  const secret = process.env.ELECTRIC_SECRET?.trim();
  if (!electricUrl || !secret) return null;
  return { electricUrl: electricUrl.replace(/\/+$/, ''), secret };
}

/** The Shape protocol's continuation parameters — the only ones a client sets. */
const CLIENT_PARAMS = new Set([
  'collection',
  'offset',
  'handle',
  'live',
  'cursor',
  'replica',
  'log',
]);

/** Electric response headers the client needs; nothing else of Electric's is passed on. */
const ELECTRIC_HEADERS = [
  'electric-cursor',
  'electric-handle',
  'electric-has-data',
  'electric-offset',
  'electric-schema',
  'electric-snapshot',
  'electric-up-to-date',
  'retry-after',
];

export function electricRoutes(
  db: Database,
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  auth: any,
): Hono {
  const app = new Hono();

  app.get('/v1/shape', async (c) => {
    const principal = await authenticate(c, auth, db);
    if (!principal) return c.json({ error: 'Unauthorized' }, 401);
    const config = readConfig();
    if (!config) {
      return c.json(
        {
          error:
            'Electric is not configured on this engine. Use provider: "crdt" or set ' +
            'ELECTRIC_URL + ELECTRIC_SECRET.',
        },
        503,
      );
    }

    const query = new URL(c.req.url).searchParams;
    for (const name of query.keys()) {
      if (!CLIENT_PARAMS.has(name)) {
        throw problem(
          'electric.param_refused',
          400,
          `"${name}" is decided by the engine, not the client. Send collection, offset, handle, ` +
            'live, cursor, replica or log.',
        );
      }
    }
    const collection = query.get('collection') ?? '';
    const def = (await DDLManager.getCollection(db, collection)) as CollectionDef | null;
    if (!collection || !def) throw problem('electric.collection', 404, 'Collection not found');
    const { user, authType } = principal;
    if (!(await checkAccess(db, user, collection, 'read'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (def.source_type === 'virtual') {
      throw problem(
        'electric.unfilterable',
        409,
        `"${collection}" is virtual: nothing to replicate.`,
      );
    }

    const scope = await readScope(db, collection, user, authType as 'session' | 'api_key');
    const columns = await DDLManager.columnNames(db, collection);
    const shape = buildShapeDefinition({
      table: scope.table,
      columns,
      // What `serializeRecord` drops: a `password` field serializes to nothing,
      // so REST never returned its hash, and Electric would have synced it.
      withheld: (({ unserved, sealed }) => new Set([...unserved, ...sealed]))(withheldColumns(def)),
      scope,
      tenants: await shapeTenantReach(db, authType === 'session' ? user.id : null, tenantId(c)),
    });
    if (!shape.ok) throw problem(shape.code, shape.status, shape.detail);

    const upstream = new URL(`${config.electricUrl}/v1/shape`);
    for (const [k, v] of shapeSearchParams(shape)) upstream.searchParams.append(k, v);
    for (const [k, v] of query) if (k !== 'collection') upstream.searchParams.set(k, v);
    upstream.searchParams.set('secret', config.secret);

    let res: Response;
    try {
      res = await fetch(upstream, { signal: c.req.raw.signal });
    } catch (err) {
      // The client went away mid-poll: nobody is left to answer.
      if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
      console.warn('[electric] upstream unreachable:', (err as Error).message);
      throw problem('electric.unreachable', 503, 'The Electric service is unreachable.');
    }
    // 409 is the protocol's `must-refetch`: the handle no longer matches this
    // caller's shape (rebuilt, or someone else's). Named, so a client tells it
    // from the engine's own 409 refusals and restarts from offset -1.
    if (res.status === 409) {
      await res.body?.cancel();
      throw problem('electric.must_refetch', 409, 'The shape changed: sync again from offset -1.');
    }
    // Any other refusal may quote the WHERE and its values, so it stays in the log.
    if (!res.ok) {
      console.warn(`[electric] upstream ${res.status} for ${scope.table}:`, await res.text());
      throw problem('electric.upstream', 502, `The Electric service answered ${res.status}.`);
    }

    const headers: Record<string, string> = {
      'content-type': res.headers.get('content-type') ?? 'application/json',
      // Per caller: the same URL is a different shape for another caller.
      'cache-control': 'private, no-store',
      vary: 'Cookie, X-API-Key, Authorization, X-Tenant-Slug',
      'access-control-expose-headers': ELECTRIC_HEADERS.join(','),
    };
    for (const h of ELECTRIC_HEADERS) {
      const v = res.headers.get(h);
      if (v !== null) headers[h] = v;
    }
    return c.body(res.body as ReadableStream, res.status as 200, headers);
  });

  return app;
}

// Internal exports for tests — never imported outside the test suite.
export const _internalForTests = { readConfig };
