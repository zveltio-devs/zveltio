/**
 * Data Import — /api/import/:collection
 *
 * Supports CSV, JSON, NDJSON upload via multipart/form-data.
 * Records are inserted in batches of 500; errors are collected per-row.
 * All imports are logged to zv_import_logs.
 *
 * POST /api/import/:collection   — FormData: file, format, skip_header, delimiter
 * GET  /api/import/jobs          — recent import logs (admin: all, user: own)
 */

import { Hono } from 'hono';
import type { Database } from '../db/index.js';
import { checkPermission } from '../lib/permissions.js';

// ── Constants ──────────────────────────────────────────────────────────────

const SAFE_IDENT = /^[a-zA-Z0-9_]{1,100}$/;
const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB
const BATCH_SIZE = 500;

// ── CSV parser ─────────────────────────────────────────────────────────────

function parseCsv(text: string, delimiter: string, skipHeader: boolean): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '';
  let inQuote = false;
  let row: string[] = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }  // escaped quote
        else inQuote = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === delimiter) {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else if (ch === '\r') {
      // skip CR — handled by \n
    } else {
      field += ch;
    }
  }
  // last field / row
  if (field || row.length > 0) { row.push(field); rows.push(row); }

  // Remove trailing empty row (common with files ending in \n)
  if (rows.at(-1)?.every(c => c === '')) rows.pop();

  if (rows.length === 0) return [];

  const header = rows[0].map(h => h.trim());
  const dataRows = skipHeader ? rows.slice(1) : rows;

  if (skipHeader) {
    return dataRows.map(r => {
      const obj: Record<string, string> = {};
      header.forEach((h, i) => { obj[h] = r[i] ?? ''; });
      return obj;
    });
  }

  // No header — use col0, col1, …
  return dataRows.map(r => {
    const obj: Record<string, string> = {};
    r.forEach((v, i) => { obj[`col${i}`] = v; });
    return obj;
  });
}

// ── Coerce value to column type ────────────────────────────────────────────

function coerce(val: string, fieldDef: any): unknown {
  if (val === '' || val === null || val === undefined) return null;
  const type: string = fieldDef?.type ?? 'text';
  if (type === 'number' || type === 'integer') {
    const n = Number(val);
    return isNaN(n) ? null : n;
  }
  if (type === 'boolean') {
    return val === 'true' || val === '1' || val === 'yes';
  }
  if (type === 'json' || type === 'jsonb') {
    try { return JSON.parse(val); } catch { return val; }
  }
  return val;
}

// ── Route factory ──────────────────────────────────────────────────────────

export function importRoutes(db: Database, _auth: any) {
  const app = new Hono();

  // ── GET /api/import/jobs ─────────────────────────────────────────────────

  app.get('/jobs', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const isAdmin = await checkPermission(user.id, 'admin', '*');

    let query = db
      .selectFrom('zv_import_logs')
      .select(['id', 'collection', 'filename', 'file_format', 'status',
               'total_rows', 'success_rows', 'error_rows', 'created_at', 'completed_at'])
      .orderBy('created_at', 'desc')
      .limit(50);

    if (!isAdmin) {
      query = query.where('created_by', '=', user.id);
    }

    const jobs = await query.execute();
    return c.json({ jobs });
  });

  // ── POST /api/import/:collection ─────────────────────────────────────────

  app.post('/:collection', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const { collection } = c.req.param();
    if (!SAFE_IDENT.test(collection)) {
      return c.json({ error: 'Invalid collection name' }, 400);
    }

    // Permission check
    const allowed = await checkPermission(user.id, collection, 'create').catch(() => false);
    if (!allowed) return c.json({ error: 'Forbidden' }, 403);

    // Parse multipart
    let formData: FormData;
    try { formData = await c.req.formData(); }
    catch { return c.json({ error: 'Expected multipart/form-data' }, 400); }

    const fileBlob = formData.get('file');
    if (!(fileBlob instanceof File)) {
      return c.json({ error: 'Missing file field' }, 400);
    }
    if (fileBlob.size > MAX_FILE_BYTES) {
      return c.json({ error: 'File exceeds 100 MB limit' }, 400);
    }

    const format = (formData.get('format') as string | null) ?? 'csv';
    if (!['csv', 'json', 'ndjson'].includes(format)) {
      return c.json({ error: 'Unsupported format. Convert XLSX to CSV first.' }, 400);
    }

    const delimiter = (formData.get('delimiter') as string | null) ?? ',';
    const skipHeader = formData.get('skip_header') !== 'false';

    // Validate collection exists + get schema
    const schemaRow = await db
      .selectFrom('zvd_collections')
      .select(['name', 'fields'])
      .where('name', '=', collection)
      .executeTakeFirst();
    if (!schemaRow) return c.json({ error: `Collection "${collection}" not found` }, 404);

    const fieldDefs: any[] = typeof (schemaRow as any).fields === 'string'
      ? JSON.parse((schemaRow as any).fields)
      : ((schemaRow as any).fields ?? []);

    const fieldMap: Record<string, any> = {};
    for (const f of fieldDefs) fieldMap[f.name] = f;

    // Valid writeable columns (schema fields only — no system cols via import)
    const validCols = new Set(fieldDefs.map((f: any) => f.name).filter((n: string) => SAFE_IDENT.test(n)));

    // Create log entry
    const logId = crypto.randomUUID();
    await db.insertInto('zv_import_logs' as any).values({
      id: logId,
      collection,
      filename: fileBlob.name,
      file_format: format === 'ndjson' ? 'ndjson' : format,
      status: 'processing',
      options: JSON.stringify({ delimiter, skip_header: skipHeader }),
      created_by: user.id,
    } as any).execute();

    // Parse file content
    const text = await fileBlob.text();

    let rawRecords: Record<string, unknown>[];
    try {
      if (format === 'json') {
        const parsed = JSON.parse(text);
        rawRecords = Array.isArray(parsed) ? parsed : [parsed];
      } else if (format === 'ndjson') {
        rawRecords = text
          .split('\n')
          .filter(l => l.trim())
          .map(l => JSON.parse(l));
      } else {
        rawRecords = parseCsv(text, delimiter === '\\t' ? '\t' : delimiter, skipHeader) as any;
      }
    } catch (err) {
      await db.updateTable('zv_import_logs' as any)
        .set({ status: 'failed', completed_at: new Date() } as any)
        .where('id', '=', logId)
        .execute();
      return c.json({ error: `Parse error: ${String(err)}`, status: 'failed', total_rows: 0, success_rows: 0, error_rows: 0 }, 400);
    }

    const totalRows = rawRecords.length;
    let successRows = 0;
    let errorRows = 0;
    const errors: { row: number; error: string }[] = [];

    // Process in batches
    for (let start = 0; start < rawRecords.length; start += BATCH_SIZE) {
      const batch = rawRecords.slice(start, start + BATCH_SIZE);
      const toInsert: Record<string, unknown>[] = [];

      for (let i = 0; i < batch.length; i++) {
        const raw = batch[i];
        const rowNum = start + i + 1;

        // Build validated record
        const record: Record<string, unknown> = {
          id: crypto.randomUUID(),
          created_by: user.id,
          updated_by: user.id,
        };

        for (const [key, rawVal] of Object.entries(raw)) {
          if (!validCols.has(key)) continue; // ignore unknown columns silently
          record[key] = coerce(String(rawVal ?? ''), fieldMap[key]);
        }

        // Must have at least one schema field
        const hasData = Object.keys(record).some(k => validCols.has(k));
        if (!hasData) {
          errors.push({ row: rowNum, error: 'No valid columns in row' });
          errorRows++;
          continue;
        }

        toInsert.push(record);
      }

      if (toInsert.length > 0) {
        try {
          await db.insertInto(collection as any).values(toInsert as any).execute();
          successRows += toInsert.length;
        } catch (err) {
          // Batch failed — record each row as error
          for (let i = 0; i < toInsert.length; i++) {
            errors.push({ row: start + i + 1, error: String(err) });
            errorRows++;
          }
        }
      }
    }

    const status = errorRows === 0 ? 'completed' : successRows === 0 ? 'failed' : 'partial';

    await db.updateTable('zv_import_logs' as any)
      .set({
        status,
        total_rows: totalRows,
        processed_rows: totalRows,
        success_rows: successRows,
        error_rows: errorRows,
        errors: JSON.stringify(errors.slice(0, 100)), // cap stored errors at 100
        completed_at: new Date(),
      } as any)
      .where('id', '=', logId)
      .execute();

    return c.json({
      status,
      job_id: logId,
      total_rows: totalRows,
      success_rows: successRows,
      error_rows: errorRows,
      ...(errors.length > 0 ? { errors: errors.slice(0, 20) } : {}),
    });
  });

  return app;
}
