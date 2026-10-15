import type { MiddlewareHandler } from 'hono';
import { sql } from 'kysely';
import { withSavepoint } from '../lib/savepoint.js';
import type { Database } from '../db/index.js';
import { withPreviewSchema } from '../db/dynamic.js';

// Preview environment middleware — when X-Preview-Token header is present,
// look up the matching branch schema and set search_path for this request.
// This gives the branch an isolated PostgreSQL schema without a separate server.
//
// HEADER ONLY. The token used to be accepted from `?_preview=` as well, and a
// query string is the one place a credential should never travel: proxies, CDNs
// and load balancers log query strings by default, browsers keep them in
// history, and they ride along in Referer. The header does none of that.
//
// Removing it was safe to check rather than assume — the form appeared in no
// documentation and had no consumer in the SDK, client, CLI or Studio, and this
// middleware is mounted on `/api/data/*`, an API surface nobody navigates to.
// A caller that still sends it gets a warning naming the replacement, because a
// credential silently ignored is worse than one loudly refused.
export function previewEnvMiddleware(db: Database): MiddlewareHandler {
  return async (c, next) => {
    const token = c.req.header('x-preview-token');
    if (!token) {
      if (c.req.query('_preview')) {
        console.warn(
          '[preview-env] ignoring `?_preview=` — a preview token in a query string ends up ' +
            'in proxy logs, browser history and Referer headers. Send it as the ' +
            '`X-Preview-Token` header instead.',
        );
      }
      return next();
    }

    // Guarded: what follows is allowed to fail, and "allowed to fail" has to be
    // made true rather than assumed. The lookup runs on the request's
    // transaction; a failed statement aborts it, and the `catch` below would
    // then hand back a request whose every later statement answers 25P02 —
    // including, once the connection returns to the pool, statements belonging
    // to somebody else. See lib/savepoint.ts for the trace.
    await withSavepoint(
      db,
      'zv_preview_env',
      async () => {
        // No tenant predicate, on purpose. A branch is a copy of the SHARED
        // structure, minted only by an instance admin (`requireInstanceAdmin`),
        // and `zv_schema_branches` is declared instance-level in
        // quality-gates/tenant-boundary.json. The token picks a schema, never
        // whose rows: every branch table carries `public`'s RLS policies
        // (`mirrorPublicProtections` in routes/schema-branches.ts), so the
        // caller still reaches only its own tenant. Pinned by
        // tests/harness/schema-branches.test.ts ("a token minted in one tenant").
        //
        // Through a SECURITY DEFINER function (migration 068): the request role
        // holds no SELECT on `preview_token`, so SQL running as it cannot list
        // the tokens. The function answers only for an enabled, unexpired token,
        // and clears an expired one on the way.
        const result = await sql<{ preview_schema: string | null }>`
          SELECT preview_schema FROM zveltio_preview_branch(${token}) LIMIT 1
        `.execute(db);
        const schema = result.rows[0]?.preview_schema;
        if (schema) {
          // Set search_path for this connection so queries hit the branch schema first
          await sql`SET LOCAL search_path TO ${sql.id(schema)}, public`.execute(db);
          c.set('previewSchema', schema);
        }
      },
      () => {
        /* non-fatal — fall through to the normal schema */
      },
    );

    // The masking views (L37 layer 3) are `public`'s: a preview reads its branch's tables.
    const schema = c.get('previewSchema' as never) as string | undefined;
    return schema ? withPreviewSchema(schema, next) : next();
  };
}
