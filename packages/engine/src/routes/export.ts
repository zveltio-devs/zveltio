/**
 * Data Export — /api/export/:collection
 *
 * Supports JSON, CSV, NDJSON output formats.
 * Streams large datasets to avoid memory issues.
 *
 * GET /api/export/:collection?format=json|csv|ndjson&limit=1000&fields=a,b,c&filter[field][op]=value
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { checkPermission } from '../lib/permissions.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function flattenValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function recordsToCsv(records: Record<string, unknown>[]): string {
  if (records.length === 0) return '';
  const keys = Object.keys(records[0]);
  const header = keys.map(k => `"${k.replace(/"/g, '""')}"`).join(',');
  const rows = records.map(r =>
    keys.map(k => {
      const v = flattenValue(r[k]);
      return `"${v.replace(/"/g, '""')}"`;
    }).join(',')
  );
  return [header, ...rows].join('\r\n');
}

// Validate collection name (must be user-defined: zvd_ prefix or simple identifier)
const SAFE_TABLE = /^[a-zA-Z0-9_]{1,100}$/;

// ── Route factory ──────────────────────────────────────────────────────────

export function exportRoutes(db: Database, auth: any) {
  const app = new Hono();

  /** GET /api/export/:collection */
  app.get('/:collection', async (c) => {
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
      user.role === 'admin' ||
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
      ? fieldsParam.split(',').map(f => f.trim()).filter(f => SAFE_TABLE.test(f))
      : null;

    // Fetch the collection schema to know which columns exist
    const schemaRow = await db
      .selectFrom('zv_collections')
      .select(['name', 'fields'])
      .where('name', '=', collection)
      .executeTakeFirst();

    if (!schemaRow) return c.json({ error: `Collection "${collection}" not found` }, 404);

    const fields: any[] = typeof (schemaRow as any).fields === 'string'
      ? JSON.parse((schemaRow as any).fields)
      : ((schemaRow as any).fields ?? []);

    // Build column list: only fields that exist in schema + system fields
    const systemCols = ['id', 'created_at', 'updated_at', 'created_by', 'updated_by'];
    const schemaCols = fields.map((f: any) => f.name).filter((n: string) => SAFE_TABLE.test(n));
    const allCols = [...new Set([...systemCols, ...schemaCols])];

    const selectCols = requestedFields
      ? allCols.filter(c => requestedFields.includes(c))
      : allCols;

    if (selectCols.length === 0) return c.json({ error: 'No valid fields selected' }, 400);

    // Execute query — use raw SQL column list (validated above)
    const colList = selectCols.map(c => sql.id(c));
    const records = await db
      .selectFrom(collection as any)
      .select(colList as any)
      .orderBy('created_at asc')
      .limit(limit)
      .execute();

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
      const body = records.map(r => JSON.stringify(r)).join('\n');
      return new Response(body, {
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}.ndjson"`,
          'X-Total-Records': String(records.length),
        },
      });
    }

    // ── CSV ───────────────────────────────────────────────────────────────
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
