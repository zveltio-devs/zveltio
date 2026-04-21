/**
 * Documents Management (RO compliance doc generation)
 *
 * GET    /api/documents/templates           — list active templates
 * GET    /api/documents/templates/:id       — get single template
 * POST   /api/documents/templates           — create template (admin)
 * PATCH  /api/documents/templates/:id       — update template (admin)
 * DELETE /api/documents/templates/:id       — delete template (admin)
 * POST   /api/documents/generate/:id        — generate PDF from template
 * GET    /api/documents/generated           — list generated documents
 * GET    /api/documents/generated/:id       — get single generated document
 */

import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { auth } from '../lib/auth.js';
import { checkPermission } from '../lib/permissions.js';
import { renderTemplate, generatePDF, getNextDocumentNumber } from '../lib/doc-generator.js';
import { DDLManager } from '../lib/ddl-manager.js';

export function documentsRoutes(db: Database, _auth: any): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    const row = await db.selectFrom('user' as any).select(['role'] as any).where('id' as any, '=', session.user.id).executeTakeFirst() as any;
    c.set('user', { ...session.user, role: row?.role ?? (session.user as any).role });
    return next();
  });

  // GET /templates
  app.get('/templates', async (c) => {
    const result = await sql<any>`
      SELECT * FROM zv_doc_templates WHERE is_active = true ORDER BY name ASC
    `.execute(db);
    return c.json({ templates: result.rows });
  });

  // GET /templates/:id
  app.get('/templates/:id', async (c) => {
    const id = c.req.param('id');
    const result = await sql<any>`SELECT * FROM zv_doc_templates WHERE id = ${id}`.execute(db);
    if (result.rows.length === 0) return c.json({ error: 'Template not found' }, 404);
    return c.json({ template: result.rows[0] });
  });

  // POST /templates — create (admin)
  app.post('/templates', async (c) => {
    const user = c.get('user');
    const isAdmin = await checkPermission(user.id, 'admin', '*');
    if (!isAdmin) return c.json({ error: 'Admin access required' }, 403);

    const body = await c.req.json();
    const result = await sql<{ id: string }>`
      INSERT INTO zv_doc_templates (name, type, description, template_html, template_text, variables, source_collection, field_mapping, prefix, created_by)
      VALUES (
        ${body.name}, ${body.type}, ${body.description || null},
        ${body.template_html}, ${body.template_text || null},
        ${JSON.stringify(body.variables || [])}::jsonb,
        ${body.source_collection || null},
        ${JSON.stringify(body.field_mapping || {})}::jsonb,
        ${body.prefix || ''}, ${user.id}
      )
      RETURNING id
    `.execute(db);

    const templateResult = await sql<any>`SELECT * FROM zv_doc_templates WHERE id = ${result.rows[0].id}`.execute(db);
    return c.json({ template: templateResult.rows[0] }, 201);
  });

  // PATCH /templates/:id — update (admin)
  app.patch('/templates/:id', async (c) => {
    const user = c.get('user');
    const isAdmin = await checkPermission(user.id, 'admin', '*');
    if (!isAdmin) return c.json({ error: 'Admin access required' }, 403);

    const id = c.req.param('id');
    const body = await c.req.json();

    const existing = await sql<{ id: string }>`SELECT id FROM zv_doc_templates WHERE id = ${id}`.execute(db);
    if (existing.rows.length === 0) return c.json({ error: 'Template not found' }, 404);

    const ALLOWED = ['name', 'type', 'description', 'template_html', 'template_text', 'variables', 'source_collection', 'field_mapping', 'prefix', 'is_active'];

    // Build SET clauses using Kysely's sql template — fully parameterized, no sql.raw().
    const setClauses: ReturnType<typeof sql>[] = [];
    for (const key of ALLOWED) {
      if (body[key] === undefined) continue;
      const col = sql.id(key);
      if (key === 'variables' || key === 'field_mapping') {
        // JSONB columns require explicit cast
        setClauses.push(sql`${col} = ${JSON.stringify(body[key])}::jsonb`);
      } else {
        setClauses.push(sql`${col} = ${body[key]}`);
      }
    }

    if (setClauses.length === 0) return c.json({ error: 'No fields to update' }, 400);

    setClauses.push(sql`updated_at = NOW()`);
    await sql`UPDATE zv_doc_templates SET ${sql.join(setClauses, sql`, `)} WHERE id = ${id}`.execute(db);

    const templateResult = await sql<any>`SELECT * FROM zv_doc_templates WHERE id = ${id}`.execute(db);
    return c.json({ template: templateResult.rows[0] });
  });

  // DELETE /templates/:id (admin)
  app.delete('/templates/:id', async (c) => {
    const user = c.get('user');
    const isAdmin = await checkPermission(user.id, 'admin', '*');
    if (!isAdmin) return c.json({ error: 'Admin access required' }, 403);

    const id = c.req.param('id');
    const result = await sql`DELETE FROM zv_doc_templates WHERE id = ${id} RETURNING id`.execute(db);
    if (result.rows.length === 0) return c.json({ error: 'Template not found' }, 404);
    return c.json({ success: true });
  });

  // POST /generate/:templateId — generate PDF
  app.post('/generate/:templateId', async (c) => {
    const user = c.get('user');
    const templateId = c.req.param('templateId');

    const templateResult = await sql<any>`SELECT * FROM zv_doc_templates WHERE id = ${templateId}`.execute(db);
    const template = templateResult.rows[0];
    if (!template) return c.json({ error: 'Template not found' }, 404);

    const body = await c.req.json();
    const { variables_data, source_record_id, source_collection } = body;

    let allVariables: Record<string, any> = variables_data ? { ...variables_data } : {};

    if (source_collection && source_record_id) {
      // IDOR fix: verify the user has read access to the source collection
      // before fetching the record and embedding its data into the document.
      const canRead = await checkPermission(user.id, source_collection, 'read');
      if (!canRead) {
        return c.json({ error: `Access denied to collection "${source_collection}"` }, 403);
      }

      const collectionDef = await DDLManager.getCollection(db, source_collection).catch(() => null);
      if (!collectionDef) return c.json({ error: 'Invalid source collection' }, 400);

      const tableName = DDLManager.getTableName(source_collection);
      try {
        const recordResult = await sql<any>`SELECT * FROM ${sql.id(tableName)} WHERE id = ${source_record_id}`.execute(db);
        const record = recordResult.rows[0];
        if (record) {
          const mapping = typeof template.field_mapping === 'string'
            ? JSON.parse(template.field_mapping)
            : template.field_mapping || {};
          for (const [varName, fieldName] of Object.entries(mapping)) {
            allVariables[varName] = record[fieldName as string];
          }
          allVariables = { ...record, ...allVariables };
        }
      } catch { /* table may not exist */ }
    }

    allVariables._data_generare = new Date().toLocaleDateString('ro-RO');
    allVariables._generata_de = user.name || user.id;

    const docNumber = await getNextDocumentNumber(db, templateId, template.prefix || '');
    allVariables._numar_document = docNumber;

    const htmlContent = renderTemplate(template.template_html, allVariables);
    const pdfBuffer = await generatePDF(htmlContent, { title: `${template.name} ${docNumber}`, subject: template.type });

    await sql`
      INSERT INTO zv_generated_docs (template_id, template_name, source_collection, source_record_id, document_number, variables_data, html_content, generated_by)
      VALUES (${templateId}, ${template.name}, ${source_collection || null}, ${source_record_id || null}, ${docNumber}, ${JSON.stringify(allVariables)}::jsonb, ${htmlContent}, ${user.id})
    `.execute(db);

    c.header('Content-Type', 'application/pdf');
    c.header('Content-Disposition', `attachment; filename="${template.name.replace(/\s/g, '_')}_${docNumber.replace(/\//g, '-')}.pdf"`);
    return c.body(new Uint8Array(pdfBuffer));
  });

  // GET /generated — list generated docs
  // Admins see all; regular users see only their own documents.
  app.get('/generated', async (c) => {
    const user = c.get('user') as any;
    const isAdmin = await checkPermission(user.id, 'admin', '*');
    const templateId = c.req.query('template_id');
    const sourceCollection = c.req.query('source_collection');
    const sourceRecordId = c.req.query('source_record_id');

    // Base filter: non-admins see only documents they generated
    const ownerFilter = isAdmin ? sql`` : sql`AND generated_by = ${user.id}`;

    let result;
    if (templateId) {
      result = await sql<any>`SELECT * FROM zv_generated_docs WHERE template_id = ${templateId} ${ownerFilter} ORDER BY generated_at DESC LIMIT 50`.execute(db);
    } else if (sourceCollection && sourceRecordId) {
      result = await sql<any>`SELECT * FROM zv_generated_docs WHERE source_collection = ${sourceCollection} AND source_record_id = ${sourceRecordId} ${ownerFilter} ORDER BY generated_at DESC LIMIT 50`.execute(db);
    } else {
      result = await sql<any>`SELECT * FROM zv_generated_docs WHERE 1=1 ${ownerFilter} ORDER BY generated_at DESC LIMIT 50`.execute(db);
    }

    return c.json({ documents: result.rows });
  });

  // GET /generated/:id
  app.get('/generated/:id', async (c) => {
    const user = c.get('user') as any;
    const isAdmin = await checkPermission(user.id, 'admin', '*');
    const id = c.req.param('id');

    const result = await sql<any>`SELECT * FROM zv_generated_docs WHERE id = ${id}`.execute(db);
    if (result.rows.length === 0) return c.json({ error: 'Document not found' }, 404);

    const doc = result.rows[0];
    // Non-admins can only access their own generated documents
    if (!isAdmin && doc.generated_by !== user.id) {
      return c.json({ error: 'Document not found' }, 404);
    }

    return c.json({ document: doc });
  });

  return app;
}
