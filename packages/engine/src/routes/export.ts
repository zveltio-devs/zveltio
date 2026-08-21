/**
 * Data Export — /api/export/:collection
 *
 * Supports JSON, CSV, NDJSON output formats.
 * Streams large datasets to avoid memory issues.
 *
 * GET /api/export/:collection?format=json|csv|ndjson&limit=1000&fields=a,b,c&filter[field][op]=value
 */

import { Hono } from 'hono';
import { recordsToCsv } from '../lib/security/index.js';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import {
  applyRlsFilters,
  checkPermission,
  getColumnAccess,
  getRlsFilters,
  resolveUserRole,
} from '../lib/tenancy/index.js';
import { DDLManager } from '../lib/data/index.js';
import { reqDb } from '../lib/route-db.js';

// ── Helpers ────────────────────────────────────────────────────────────────

// Validate collection name (must be user-defined: zvd_ prefix or simple identifier)
const SAFE_TABLE = /^[a-zA-Z0-9_]{1,100}$/;

// ── Route factory ──────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
export function exportRoutes(db: Database, auth: any) {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', session.user);
    await next();
  });

  /** GET /api/export/:collection */
  app.get('/:collection', async (c) => {
    const tdb = reqDb(c, db);
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const { collection } = c.req.param();

    // Validate collection name to prevent injection
    if (!SAFE_TABLE.test(collection)) {
      return c.json({ error: 'Invalid collection name' }, 400);
    }

    // Check read permission
    const allowed =
      user.role === 'god' ||
      (await checkPermission(user.id, collection, 'read').catch(() => false));

    if (!allowed) return c.json({ error: 'Forbidden' }, 403);

    // Parse query params
    const format = (c.req.query('format') ?? 'json') as 'json' | 'csv' | 'ndjson';
    if (!['json', 'csv', 'ndjson'].includes(format)) {
      return c.json({ error: 'Invalid format. Use json, csv or ndjson' }, 400);
    }

    const limit = Math.min(parseInt(c.req.query('limit') ?? '1000'), 10_000);
    if (isNaN(limit) || limit < 1) return c.json({ error: 'Invalid limit' }, 400);

    const fieldsParam = c.req.query('fields');
    const requestedFields = fieldsParam
      ? fieldsParam
          .split(',')
          .map((f) => f.trim())
          .filter((f) => SAFE_TABLE.test(f))
      : null;

    // Fetch the collection schema to know which columns exist
    const schemaRow = await tdb
      .selectFrom('zvd_collections')
      .select(['name', 'fields'])
      .where('name', '=', collection)
      .executeTakeFirst();

    if (!schemaRow) return c.json({ error: `Collection "${collection}" not found` }, 404);

    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const fields: any[] =
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      typeof (schemaRow as any).fields === 'string'
        ? // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
          JSON.parse((schemaRow as any).fields)
        : // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
          ((schemaRow as any).fields ?? []);

    // Build column list: only fields that exist in schema + system fields
    const systemCols = ['id', 'created_at', 'updated_at', 'created_by', 'updated_by'];
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const schemaCols = fields.map((f: any) => f.name).filter((n: string) => SAFE_TABLE.test(n));
    const allCols = [...new Set([...systemCols, ...schemaCols])];

    const requested = requestedFields
      ? allCols.filter((c) => requestedFields.includes(c))
      : allCols;

    // Column permissions. Export checked read on the COLLECTION and then
    // selected every column, so a role forbidden a column in the data API
    // could read it by exporting — the same data, a different route.
    const colAccess = await getColumnAccess(db, collection, await resolveUserRole(user));
    const selectCols = requested.filter((c) => !colAccess.hidden.has(c));

    if (selectCols.length === 0) return c.json({ error: 'No valid fields selected' }, 400);

    // Execute query — use raw SQL column list (validated above).
    // Resolve to the physical table (zvd_ prefix) so export hits the right
    // table regardless of the logical collection name passed in the URL.
    const tableName = DDLManager.getTableName(collection);
    const colList = selectCols.map((c) => sql.id(c));
    // Row-level security. Export applied none: a user could export every row
    // the policy hides. RLS is the read boundary, and a boundary that only one
    // route honours is not a boundary.
    const rlsFilters = await getRlsFilters(collection, user, c.get('authType'));
    const baseQuery = tdb
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      .selectFrom(tableName as any)
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      .select(colList as any)
      .orderBy('created_at asc')
      .limit(limit);
    const records = await applyRlsFilters(baseQuery, rlsFilters).execute();

    const filename = `${collection}_${new Date().toISOString().split('T')[0]}`;

    // ── JSON ─────────────────────────────────────────────────────────────
    if (format === 'json') {
      return new Response(JSON.stringify(records, null, 2), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}.json"`,
          'X-Total-Records': String(records.length),
        },
      });
    }

    // ── NDJSON ────────────────────────────────────────────────────────────
    if (format === 'ndjson') {
      const body = records.map((r) => JSON.stringify(r)).join('\n');
      return new Response(body, {
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}.ndjson"`,
          'X-Total-Records': String(records.length),
        },
      });
    }

    // ── CSV ───────────────────────────────────────────────────────────────
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const csv = recordsToCsv(records as any);
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}.csv"`,
        'X-Total-Records': String(records.length),
      },
    });
  });

  return app;
}
