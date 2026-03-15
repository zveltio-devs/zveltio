import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Database } from '../../../../packages/engine/src/db/index.js';
import { checkPermission } from '../../../../packages/engine/src/lib/permissions.js';
import { DDLManager } from '../../../../packages/engine/src/lib/ddl-manager.js';
import { dynamicInsert } from '../../../../packages/engine/src/db/dynamic.js';
import { fieldTypeRegistry } from '../../../../packages/engine/src/lib/field-type-registry.js';

async function requireAdmin(c: any, auth: any): Promise<any | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  if (!(await checkPermission(session.user.id, 'admin', '*'))) return null;
  return session.user;
}

// Parse CSV into rows — lightweight implementation without external dep
function parseCSV(text: string, delimiter = ','): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0], delimiter);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseCSVLine(lines[i], delimiter);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h.trim()] = (values[idx] ?? '').trim();
    });
    rows.push(row);
  }

  return rows;
}

function parseCSVLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' && !inQuotes) {
      inQuotes = true;
    } else if (char === '"' && inQuotes) {
      if (line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = false;
      }
    } else if (char === delimiter && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

// Process import in background and update job status
async function runImport(
  db: Database,
  jobId: string,
  collection: string,
  rows: Record<string, string>[],
  options: {
    mapping?: Record<string, string>;
    skip_validation?: boolean;
    update_on_conflict?: string;
  },
  collectionDef: any,
): Promise<void> {
  let processed = 0;
  let success = 0;
  const errors: Array<{ row: number; error: string }> = [];

  await (db as any)
    .updateTable('zv_import_logs')
    .set({ status: 'processing', total_rows: rows.length })
    .where('id', '=', jobId)
    .execute();

  const tableName = DDLManager.getTableName(collection);
  const mapping = options.mapping ?? {};

  for (const [idx, rawRow] of rows.entries()) {
    try {
      // Apply column mapping
      const row: Record<string, any> = {};
      for (const [col, value] of Object.entries(rawRow)) {
        const mappedCol = mapping[col] ?? col;
        row[mappedCol] = value === '' ? null : value;
      }

      // Deserialize via field registry
      if (collectionDef?.fields) {
        for (const field of collectionDef.fields) {
          if (row[field.name] !== undefined) {
            row[field.name] = fieldTypeRegistry.deserialize(field.type, row[field.name]);
          }
        }
      }

      await dynamicInsert(db, tableName, row);
      success++;
    } catch (err: any) {
      errors.push({ row: idx + 1, error: err?.message ?? 'Unknown error' });
    }
    processed++;
  }

  const finalStatus = errors.length === 0
    ? 'completed'
    : errors.length === processed ? 'failed' : 'partial';

  await (db as any)
    .updateTable('zv_import_logs')
    .set({
      status: finalStatus,
      processed_rows: processed,
      success_rows: success,
      error_rows: errors.length,
      errors: JSON.stringify(errors.slice(0, 100)), // cap error list
      completed_at: new Date(),
    })
    .where('id', '=', jobId)
    .execute();
}

export function importRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // Admin auth middleware
  app.use('*', async (c, next) => {
    const user = await requireAdmin(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', user);
    await next();
  });

  // GET /jobs — List import jobs
  app.get('/jobs', async (c) => {
    const { collection, limit = '20' } = c.req.query();
    let query = (db as any)
      .selectFrom('zv_import_logs')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(Math.min(parseInt(limit), 100));

    if (collection) query = query.where('collection', '=', collection);

    const jobs = await query.execute();
    return c.json({ jobs });
  });

  // GET /jobs/:id — Get import job status
  app.get('/jobs/:id', async (c) => {
    const job = await (db as any)
      .selectFrom('zv_import_logs')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!job) return c.json({ error: 'Import job not found' }, 404);
    return c.json({ job });
  });

  // POST /:collection — Import CSV or JSON data
  app.post('/:collection', async (c) => {
    const user = c.get('user') as any;
    const collection = c.req.param('collection');

    if (!(await DDLManager.tableExists(db, collection))) {
      return c.json({ error: 'Collection not found' }, 404);
    }

    const collectionDef = await DDLManager.getCollection(db, collection);
    const contentType = c.req.header('Content-Type') ?? '';

    let rows: Record<string, any>[] = [];
    let fileFormat: string;
    let filename = 'import';

    if (contentType.includes('multipart/form-data')) {
      // File upload
      const formData = await c.req.formData();
      const file = formData.get('file') as File | null;
      if (!file) return c.json({ error: 'No file provided' }, 400);

      filename = file.name;
      const text = await file.text();

      if (file.name.endsWith('.json') || file.type === 'application/json') {
        fileFormat = 'json';
        rows = JSON.parse(text);
        if (!Array.isArray(rows)) return c.json({ error: 'JSON must be an array of objects' }, 400);
      } else {
        // CSV
        fileFormat = 'csv';
        const delimiter = (formData.get('delimiter') as string) ?? ',';
        rows = parseCSV(text, delimiter);
      }
    } else if (contentType.includes('application/json')) {
      // Direct JSON body: { rows: [...], options: {...} }
      const body = await c.req.json();
      rows = body.rows ?? body;
      fileFormat = 'json';
      filename = 'inline_import';
      if (!Array.isArray(rows)) return c.json({ error: 'Body must be array or { rows: [] }' }, 400);
    } else {
      // Raw CSV body
      fileFormat = 'csv';
      const text = await c.req.text();
      const delimiter = c.req.query('delimiter') ?? ',';
      rows = parseCSV(text, delimiter);
    }

    if (rows.length === 0) return c.json({ error: 'No rows to import' }, 400);
    if (rows.length > 10_000) return c.json({ error: 'Import limited to 10,000 rows per request' }, 400);

    // Parse options
    let mapping: Record<string, string> = {};
    const mappingParam = c.req.query('mapping');
    if (mappingParam) {
      try { mapping = JSON.parse(mappingParam); } catch { /* ignore */ }
    }

    const options = { mapping, skip_validation: c.req.query('skip_validation') === 'true' };

    // Create import log
    const job = await (db as any)
      .insertInto('zv_import_logs')
      .values({
        collection,
        filename,
        file_format: fileFormat,
        status: 'pending',
        total_rows: rows.length,
        options: JSON.stringify(options),
        created_by: user.id,
      })
      .returningAll()
      .executeTakeFirst();

    // Run import in background (Bun.js supports this via Promise without await)
    runImport(db, job.id, collection, rows, options, collectionDef).catch((err) => {
      (db as any)
        .updateTable('zv_import_logs')
        .set({
          status: 'failed',
          errors: JSON.stringify([{ row: 0, error: String(err) }]),
          completed_at: new Date(),
        })
        .where('id', '=', job.id)
        .execute()
        .catch(() => { /* ignore */ });
    });

    return c.json(
      {
        job_id: job.id,
        message: `Import started: ${rows.length} rows queued`,
        status: 'processing',
      },
      202,
    );
  });

  // POST /:collection/preview — Preview first N rows without importing
  app.post('/:collection/preview', async (c) => {
    const collection = c.req.param('collection');

    if (!(await DDLManager.tableExists(db, collection))) {
      return c.json({ error: 'Collection not found' }, 404);
    }

    const contentType = c.req.header('Content-Type') ?? '';
    let rows: Record<string, any>[] = [];

    if (contentType.includes('multipart/form-data')) {
      const formData = await c.req.formData();
      const file = formData.get('file') as File | null;
      if (!file) return c.json({ error: 'No file provided' }, 400);

      const text = await file.text();
      const delimiter = (formData.get('delimiter') as string) ?? ',';
      rows = file.name.endsWith('.json') ? JSON.parse(text) : parseCSV(text, delimiter);
    } else {
      const text = await c.req.text();
      rows = parseCSV(text);
    }

    const preview = rows.slice(0, 10);
    const headers = preview.length > 0 ? Object.keys(preview[0]) : [];

    return c.json({
      total_rows: rows.length,
      preview,
      headers,
      collection_fields: (await DDLManager.getCollection(db, collection))?.fields ?? [],
    });
  });

  return app;
}
