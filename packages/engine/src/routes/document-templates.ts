/**
 * Document Templates (admin-only)
 *
 * GET    /api/document-templates              — list templates
 * GET    /api/document-templates/:id          — get single template
 * POST   /api/document-templates              — create template
 * PATCH  /api/document-templates/:id          — update template
 * DELETE /api/document-templates/:id          — delete template
 * POST   /api/document-templates/:id/generate — generate PDF from template
 * GET    /api/document-templates/:id/generations — list generation history
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import PDFDocument from 'pdfkit';
import type { Database } from '../db/index.js';
import { auth } from '../lib/auth.js';
import { checkPermission } from '../lib/permissions.js';

// ── Schemas ───────────────────────────────────────────────────────────────────

const DocumentTemplateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  template_type: z.enum(['html', 'markdown', 'handlebars', 'mustache']).default('html'),
  output_format: z.enum(['pdf', 'docx', 'html', 'markdown', 'txt']).default('pdf'),
  content: z.string().min(1),
  variables: z.record(z.string(), z.string()).optional().default({}),
  style_config: z.record(z.string(), z.any()).optional().default({}),
  is_active: z.boolean().default(true),
});

const UpdateDocumentTemplateSchema = DocumentTemplateSchema.partial();

const GenerateSchema = z.object({
  variables: z.record(z.string(), z.any()).optional().default({}),
  output_format: z.enum(['pdf', 'docx', 'html', 'markdown', 'txt']).optional(),
});

// ── Template renderer ──────────────────────────────────────────────────────────

function populatePlaceholders(template: string, variables: Record<string, any>): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, key) => {
    const keys = key.split('.');
    let value: any = variables;
    for (const k of keys) {
      value = value?.[k];
      if (value === undefined || value === null) return '';
    }
    if (value instanceof Date) return value.toLocaleDateString('ro-RO');
    return String(value);
  });
}

async function renderToPDF(
  content: string,
  styleConfig: any,
): Promise<Buffer> {
  const plainText = content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<h([1-6])[^>]*>(.*?)<\/h\1>/gi, (_, level, text) =>
      `\n__H${level}__${text.replace(/<[^>]+>/g, '')}__END__\n`,
    )
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: styleConfig?.page_size || 'A4',
      layout: styleConfig?.orientation || 'portrait',
      margin: 60,
    });

    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    for (const line of plainText.split('\n')) {
      const h1 = line.match(/^__H1__(.*)__END__$/);
      const h2 = line.match(/^__H2__(.*)__END__$/);
      const h3 = line.match(/^__H[3-6]__(.*)__END__$/);

      if (h1) {
        doc.fontSize(20).font('Helvetica-Bold').text(h1[1].trim(), { lineBreak: true });
        doc.fontSize(11).font('Helvetica');
      } else if (h2) {
        doc.fontSize(16).font('Helvetica-Bold').text(h2[1].trim(), { lineBreak: true });
        doc.fontSize(11).font('Helvetica');
      } else if (h3) {
        doc.fontSize(13).font('Helvetica-Bold').text(h3[1].trim(), { lineBreak: true });
        doc.fontSize(11).font('Helvetica');
      } else if (line.trim() === '') {
        doc.moveDown(0.5);
      } else {
        doc.fontSize(11).font('Helvetica').text(line, { lineBreak: true });
      }
    }

    doc.end();
  });
}

// ── Route factory ─────────────────────────────────────────────────────────────

export function documentTemplatesRoutes(db: Database, _auth: any): Hono {
  const app = new Hono<{ Variables: { user: any } }>();

  // Admin-only middleware
  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', session.user);
    const hasAdmin = await checkPermission(session.user.id, 'admin', '*');
    if (!hasAdmin) return c.json({ error: 'Admin access required' }, 403);
    return next();
  });

  // GET /
  app.get('/', async (c) => {
    const result = await (db as any).selectFrom('zv_document_templates').selectAll().orderBy('name').execute();
    return c.json({ templates: result });
  });

  // GET /:id
  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    const template = await (db as any)
      .selectFrom('zv_document_templates').selectAll().where('id', '=', id).executeTakeFirst();
    if (!template) return c.json({ error: 'Template not found' }, 404);
    return c.json({ template });
  });

  // POST /
  app.post('/', zValidator('json', DocumentTemplateSchema), async (c) => {
    const data = c.req.valid('json');
    const result = await sql<any>`
      INSERT INTO zv_document_templates (name, description, template_type, output_format, content, variables, style_config, is_active)
      VALUES (${data.name}, ${data.description || null}, ${data.template_type}, ${data.output_format},
              ${data.content}, ${JSON.stringify(data.variables)}::jsonb, ${JSON.stringify(data.style_config)}::jsonb, ${data.is_active})
      RETURNING *
    `.execute(db);
    return c.json({ template: result.rows[0] }, 201);
  });

  // PATCH /:id
  app.patch('/:id', zValidator('json', UpdateDocumentTemplateSchema), async (c) => {
    const id = c.req.param('id');
    const data = c.req.valid('json');

    const existing = await (db as any)
      .selectFrom('zv_document_templates').select('id').where('id', '=', id).executeTakeFirst();
    if (!existing) return c.json({ error: 'Template not found' }, 404);

    const updateFields: Record<string, any> = { updated_at: new Date() };
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (key === 'variables' || key === 'style_config') {
        updateFields[key] = JSON.stringify(value) as any;
      } else {
        updateFields[key] = value;
      }
    }

    const template = await (db as any)
      .updateTable('zv_document_templates').set(updateFields).where('id', '=', id).returningAll().executeTakeFirst();
    return c.json({ template });
  });

  // DELETE /:id
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const result = await sql`DELETE FROM zv_document_templates WHERE id = ${id} RETURNING id`.execute(db);
    if (result.rows.length === 0) return c.json({ error: 'Template not found' }, 404);
    return c.json({ success: true });
  });

  // POST /:id/generate
  app.post('/:id/generate', zValidator('json', GenerateSchema), async (c) => {
    const templateId = c.req.param('id');
    const data = c.req.valid('json');
    const user = c.get('user');

    const template = await (db as any)
      .selectFrom('zv_document_templates').selectAll().where('id', '=', templateId).executeTakeFirst();
    if (!template) return c.json({ error: 'Template not found' }, 404);
    if (!template.is_active) return c.json({ error: 'Template is not active' }, 400);

    const populated = populatePlaceholders(template.content, data.variables || {});
    const pdfBuffer = await renderToPDF(populated, template.style_config);

    try {
      await sql`
        INSERT INTO zv_document_generations (template_id, user_id, variables, output_format, status, generated_at)
        VALUES (${templateId}, ${user?.id || null}, ${JSON.stringify(data.variables || {})}::jsonb, 'pdf', 'completed', NOW())
      `.execute(db);
    } catch { /* non-critical audit log */ }

    const filename = `${template.name.replace(/[^a-zA-Z0-9-]/g, '-')}-${Date.now()}.pdf`;
    return new Response(pdfBuffer, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  });

  // GET /:id/generations
  app.get('/:id/generations', async (c) => {
    const templateId = c.req.param('id');
    const limit = parseInt(c.req.query('limit') || '20');
    const offset = parseInt(c.req.query('offset') || '0');

    const result = await (db as any)
      .selectFrom('zv_document_generations')
      .selectAll()
      .where('template_id', '=', templateId)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset)
      .execute();

    return c.json({ generations: result });
  });

  return app;
}
