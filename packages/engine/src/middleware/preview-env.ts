import type { MiddlewareHandler } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';

// Preview environment middleware — when X-Preview-Token header is present,
// look up the matching branch schema and set search_path for this request.
// This gives the branch an isolated PostgreSQL schema without a separate server.
export function previewEnvMiddleware(db: Database): MiddlewareHandler {
  return async (c, next) => {
    const token = c.req.header('x-preview-token') ?? c.req.query('_preview');
    if (!token) return next();

    try {
      const result = await sql<{ preview_schema: string }>`
        SELECT preview_schema FROM zv_schema_branches
        WHERE preview_token = ${token} AND preview_enabled = true
        LIMIT 1
      `.execute(db);

      const schema = result.rows[0]?.preview_schema;
      if (schema) {
        // Set search_path for this connection so queries hit the branch schema first
        await sql`SET LOCAL search_path TO ${sql.id(schema)}, public`.execute(db);
        c.set('previewSchema', schema);
      }
    } catch { /* non-fatal — fall through to normal schema */ }

    return next();
  };
}
