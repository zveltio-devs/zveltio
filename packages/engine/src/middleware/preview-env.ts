import type { MiddlewareHandler } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';

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

    try {
      const result = await sql<{ preview_schema: string; preview_expires_at: Date | null }>`
        SELECT preview_schema, preview_expires_at FROM zv_schema_branches
        WHERE preview_token = ${token}
          AND preview_enabled = true
          AND (preview_expires_at IS NULL OR preview_expires_at > NOW())
        LIMIT 1
      `.execute(db);

      const row = result.rows[0];
      if (row?.preview_expires_at && new Date(row.preview_expires_at) < new Date()) {
        // Expired — auto-disable (fire-and-forget)
        sql`UPDATE zv_schema_branches SET preview_enabled = false, preview_token = NULL WHERE preview_token = ${token}`
          .execute(db)
          .catch(() => {});
      }
      const schema = row?.preview_schema;
      if (schema) {
        // Set search_path for this connection so queries hit the branch schema first
        await sql`SET LOCAL search_path TO ${sql.id(schema)}, public`.execute(db);
        c.set('previewSchema', schema);
      }
    } catch {
      /* non-fatal — fall through to normal schema */
    }

    return next();
  };
}
