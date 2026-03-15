import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { Database } from '../../../../packages/engine/src/db/index.js';
import { DDLManager } from '../../../../packages/engine/src/lib/ddl-manager.js';
import { checkPermission } from '../../../../packages/engine/src/lib/permissions.js';
import { fieldTypeRegistry } from '../../../../packages/engine/src/lib/field-type-registry.js';

function toCSV(rows: any[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.join(','),
    ...rows.map((row) =>
      headers
        .map((h) => {
          const val = row[h];
          if (val === null || val === undefined) return '';
          const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
          return str.includes(',') || str.includes('"') || str.includes('\n')
            ? `"${str.replace(/"/g, '""')}"`
            : str;
        })
        .join(','),
    ),
  ];
  return lines.join('\n');
}

function toNDJSON(rows: any[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n');
}

export function exportRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    if (!(await checkPermission(session.user.id, 'admin', '*'))) {
      return c.json({ error: 'Admin access required' }, 403);
    }
    await next();
  });

  // GET /:collection — Export collection data
  app.get(
    '/:collection',
    zValidator(
      'query',
      z.object({
        format: z.enum(['json', 'csv', 'ndjson']).default('json'),
        filter: z.string().optional(),
        limit: z.coerce.number().max(10000).default(1000),
      }),
    ),
    async (c) => {
      const collection = c.req.param('collection');
      const { format, filter, limit } = c.req.valid('query');

      if (!(await DDLManager.tableExists(db, collection))) {
        return c.json({ error: 'Collection not found' }, 404);
      }

      const tableName = DDLManager.getTableName(collection);
      const collectionDef = await DDLManager.getCollection(db, collection);

      let query = (db as any).selectFrom(tableName).selectAll().limit(limit);

      if (filter) {
        try {
          const filters = JSON.parse(filter);
          for (const [key, value] of Object.entries(filters)) {
            query = query.where(key, '=', value);
          }
        } catch { /* ignore invalid filter */ }
      }

      const rows = await query.execute();

      // Serialize using field type registry
      const serialized = rows.map((row: any) => {
        const result = { ...row };
        for (const field of (collectionDef?.fields || [])) {
          if (result[field.name] !== undefined) {
            result[field.name] = fieldTypeRegistry.serialize(field.type, result[field.name]);
          }
        }
        return result;
      });

      const filename = `${collection}_export_${new Date().toISOString().split('T')[0]}`;

      switch (format) {
        case 'csv': {
          const csv = toCSV(serialized);
          c.header('Content-Type', 'text/csv');
          c.header('Content-Disposition', `attachment; filename="${filename}.csv"`);
          return c.body(csv);
        }
        case 'ndjson': {
          const ndjson = toNDJSON(serialized);
          c.header('Content-Type', 'application/x-ndjson');
          c.header('Content-Disposition', `attachment; filename="${filename}.ndjson"`);
          return c.body(ndjson);
        }
        default: {
          c.header('Content-Disposition', `attachment; filename="${filename}.json"`);
          return c.json({ collection, count: serialized.length, records: serialized });
        }
      }
    },
  );

  // POST /:collection/import — Import records
  app.post('/:collection/import', async (c) => {
    const collection = c.req.param('collection');

    if (!(await DDLManager.tableExists(db, collection))) {
      return c.json({ error: 'Collection not found' }, 404);
    }

    const tableName = DDLManager.getTableName(collection);
    const contentType = c.req.header('Content-Type') || '';

    let records: any[] = [];

    if (contentType.includes('application/json')) {
      const body = await c.req.json();
      records = Array.isArray(body) ? body : body.records || [];
    } else {
      return c.json({ error: 'Only JSON import is supported. Use Content-Type: application/json' }, 400);
    }

    if (!Array.isArray(records) || records.length === 0) {
      return c.json({ error: 'No records to import' }, 400);
    }

    let imported = 0;
    const errors: string[] = [];

    for (const record of records) {
      try {
        // Remove system fields
        const { id, created_at, updated_at, ...data } = record;
        await (db as any).insertInto(tableName).values(data).execute();
        imported++;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : 'Unknown error');
      }
    }

    return c.json({
      success: true,
      imported,
      errors: errors.length > 0 ? errors : undefined,
    });
  });

  return app;
}
