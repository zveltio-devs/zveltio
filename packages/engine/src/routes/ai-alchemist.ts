import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import { nanoid } from 'nanoid';
import type { Database } from '../db/index.js';
import { DDLManager } from '../lib/ddl-manager.js';
import { fieldTypeRegistry } from '../lib/field-type-registry.js';
import { aiProviderManager } from '../lib/ai-provider.js';
import { checkPermission } from '../lib/permissions.js';
import { extractTextFromFile } from '../lib/cloud/document-indexer.js';

/**
 * Data Alchemist — transforms unstructured documents into structured databases.
 *
 * Pipeline:
 *   Step 1 POST /analyze  — upload files, AI extracts text + proposes schema + sample data
 *   Step 2 POST /execute  — user confirms schema, Ghost DDL creates tables + inserts data
 *
 * Mounted at /api/ai/alchemist
 */
export function aiAlchemistRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // Admin-only middleware
  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) return c.json({ error: 'Unauthorized' }, 401);
    const isAdmin = await checkPermission(session.user.id, 'admin', '*');
    if (!isAdmin) return c.json({ error: 'Admin access required' }, 403);
    c.set('user', session.user);
    await next();
  });

  // POST /api/ai/alchemist/analyze — Step 1
  app.post('/analyze', async (c) => {
    const formData = await c.req.formData();
    const files = formData.getAll('files') as File[];

    if (!files || files.length === 0) {
      return c.json({ error: 'No files provided' }, 400);
    }

    const provider = aiProviderManager.getDefault();
    if (!provider?.chat) {
      return c.json({ error: 'No AI provider configured' }, 503);
    }

    // Extract text from each file
    const documents: Array<{ name: string; content: string; mimeType: string }> = [];

    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer());
      let content: string | null = null;

      if (file.type === 'text/csv' || file.name.endsWith('.csv')) {
        content = buffer.toString('utf-8');
      } else if (
        file.type.includes('spreadsheet') ||
        file.name.endsWith('.xlsx') ||
        file.name.endsWith('.xls')
      ) {
        try {
          // @ts-expect-error xlsx is an optional peer dependency
          const XLSX = await import('xlsx');
          const workbook = XLSX.read(buffer, { type: 'buffer' });
          content = workbook.SheetNames.map((name: string) => {
            const sheet = workbook.Sheets[name];
            return `[Sheet: ${name}]\n${XLSX.utils.sheet_to_csv(sheet)}`;
          }).join('\n\n');
        } catch {
          content = `[Excel file: ${file.name} — install xlsx package]`;
        }
      } else {
        content = await extractTextFromFile(buffer, file.type);
      }

      if (content) {
        documents.push({
          name: file.name,
          content: content.slice(0, 5000),
          mimeType: file.type,
        });
      }
    }

    if (documents.length === 0) {
      return c.json({ error: 'Could not extract text from any file' }, 422);
    }

    const availableTypes = fieldTypeRegistry.list().join(', ');

    const analysisResult = await provider.chat([
      {
        role: 'system',
        content: 'You are a data extraction and schema design expert. Analyze documents and propose optimal database structures. Return ONLY valid JSON, no markdown.',
      },
      {
        role: 'user',
        content: `Analyze these ${documents.length} document(s) and propose a database schema.

DOCUMENTS:
${documents.map((d, i) => `--- Document ${i + 1}: ${d.name} (${d.mimeType}) ---\n${d.content}`).join('\n\n')}

TASK:
1. Identify what type of data these documents contain
2. Propose one or more database tables (collections) to store this data
3. Define fields for each collection with appropriate types
4. Extract sample data from the documents (up to 10 rows per collection)

AVAILABLE FIELD TYPES: ${availableTypes}

RESPONSE FORMAT (JSON only):
{
  "analysis": "Brief description of what these documents contain",
  "collections": [
    {
      "name": "collection_name_snake_case",
      "displayName": "Human Readable Name",
      "description": "What this collection stores",
      "fields": [
        { "name": "field_name", "type": "text", "required": true, "label": "Field Label" }
      ]
    }
  ],
  "extracted_data": {
    "collection_name": [
      { "field_name": "value" }
    ]
  },
  "confidence": 0.85,
  "notes": "Any caveats or suggestions"
}`,
      },
    ], { temperature: 0.2, max_tokens: 4000 });

    // Parse AI response
    let proposal: any;
    try {
      const jsonStr = analysisResult.content.match(/\{[\s\S]*\}/)?.[0];
      proposal = JSON.parse(jsonStr || '{}');
    } catch {
      return c.json({ error: 'AI returned invalid JSON', raw: analysisResult.content }, 422);
    }

    // Validate field types — unknown types fall back to 'text'
    if (proposal.collections) {
      for (const col of proposal.collections) {
        col.fields = (col.fields || []).map((f: any) => {
          if (!fieldTypeRegistry.has(f.type)) f.type = 'text';
          return f;
        });
        col._exists = await DDLManager.tableExists(db, col.name);
      }
    }

    // Cache proposal for step 2 (15-minute TTL)
    const sessionId = nanoid(16);
    try {
      const { getCache } = await import('../lib/cache.js');
      const cache = getCache();
      if (cache) {
        await (cache as any).setex(`alchemist:${sessionId}`, 900, JSON.stringify({ documents, proposal }));
      }
    } catch { /* cache unavailable — client must pass data back in execute */ }

    return c.json({ session_id: sessionId, ...proposal });
  });

  // POST /api/ai/alchemist/execute — Step 2
  app.post('/execute', zValidator('json', z.object({
    session_id: z.string(),
    collections: z.array(z.object({
      name: z.string().regex(/^[a-z][a-z0-9_]*$/),
      displayName: z.string().optional(),
      description: z.string().optional(),
      fields: z.array(z.object({
        name: z.string(),
        type: z.string(),
        required: z.boolean().optional(),
        label: z.string().optional(),
      })).min(1),
    })),
    extracted_data: z.record(z.string(), z.array(z.record(z.string(), z.any()))).optional(),
    skip_existing: z.boolean().default(true),
  })), async (c) => {
    const user = c.get('user') as any;
    const { session_id, collections, extracted_data, skip_existing } = c.req.valid('json');

    const results = {
      collections_created: [] as string[],
      collections_skipped: [] as string[],
      records_inserted: {} as Record<string, number>,
      errors: [] as string[],
    };

    // Create collections via DDLManager
    for (const col of collections) {
      try {
        const exists = await DDLManager.tableExists(db, col.name);
        if (exists && skip_existing) {
          results.collections_skipped.push(col.name);
          continue;
        }

        if (!exists) {
          // Filter to valid field types
          const validFields = col.fields
            .filter((f) => fieldTypeRegistry.has(f.type))
            .map((f) => ({
              name: f.name,
              type: f.type,
              required: f.required ?? false,
              unique: false,
              indexed: false,
              label: f.label,
            }));

          if (validFields.length === 0) {
            validFields.push({ name: 'title', type: 'text', required: true, unique: false, indexed: false, label: 'Title' });
          }

          await DDLManager.createCollection(db, {
            name: col.name,
            displayName: col.displayName || col.name,
            description: col.description,
            fields: validFields,
          });
          results.collections_created.push(col.name);
        }
      } catch (err: any) {
        results.errors.push(`${col.name}: ${err.message}`);
      }
    }

    // Insert extracted data
    if (extracted_data) {
      for (const [colName, rows] of Object.entries(extracted_data)) {
        if (!rows || rows.length === 0) continue;
        const tableName = DDLManager.getTableName(colName);

        // Validate that the table name is safe (should always be zvd_ prefixed)
        const SAFE_TABLE_RE = /^zvd_[a-z][a-z0-9_]*$/;
        if (!SAFE_TABLE_RE.test(tableName)) continue;

        // Validate column names against regex to prevent SQL injection from AI response
        const SAFE_COL_RE = /^[a-z][a-z0-9_]*$/;

        let inserted = 0;
        for (const row of rows) {
          try {
            const cleanRow: any = {};
            for (const [k, v] of Object.entries(row)) {
              if (k === 'id') continue; // strip id — let DB generate
              if (!SAFE_COL_RE.test(k)) continue; // skip unsafe column names from AI response
              cleanRow[k] = v;
            }
            cleanRow.created_by = user.id;

            // Build dynamic INSERT; column names already validated by SAFE_COL_RE above
            const cols = Object.keys(cleanRow);
            if (cols.length === 0) continue;
            const vals = Object.values(cleanRow);
            // sql.id() quotes identifiers; sql.join() assembles the fragment list
            const colParts = sql.join(cols.map((c) => sql.id(c)));
            const valParts = sql.join(vals.map((v) => sql`${v}`));

            await sql`INSERT INTO ${sql.id(tableName)} (${colParts}) VALUES (${valParts})`.execute(db);
            inserted++;
          } catch { /* row-level failure: continue */ }
        }
        results.records_inserted[colName] = inserted;
      }
    }

    // Clean up cache session
    try {
      const { getCache } = await import('../lib/cache.js');
      const cache = getCache();
      if (cache) await (cache as any).del(`alchemist:${session_id}`);
    } catch { /* ignore */ }

    return c.json({
      success: true,
      ...results,
      message: `Created ${results.collections_created.length} collection(s), inserted data into ${Object.keys(results.records_inserted).length} collection(s)`,
    });
  });

  // GET /api/ai/alchemist/sessions/:id — Retrieve cached proposal
  app.get('/sessions/:id', async (c) => {
    try {
      const { getCache } = await import('../lib/cache.js');
      const cache = getCache();
      if (!cache) return c.json({ error: 'Cache not available' }, 503);
      const data = await (cache as any).get(`alchemist:${c.req.param('id')}`);
      if (!data) return c.json({ error: 'Session not found or expired' }, 404);
      return c.json(JSON.parse(data));
    } catch {
      return c.json({ error: 'Cache error' }, 500);
    }
  });

  return app;
}
