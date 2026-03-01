import { Hono } from 'hono';
import { sql } from 'kysely';
import { checkPermission } from '../lib/permissions.js';
import { DDLManager } from '../lib/ddl-manager.js';
import type { Database } from '../db/index.js';

// =========================================================
// PUBLIC ROUTES — No auth required (serve the website)
// =========================================================
export function publicPagesRoutes(db: Database): Hono {
  const router = new Hono();

  // GET /api/pages — list active pages
  router.get('/', async (c) => {
    const result = await sql<any>`
      SELECT id::text, title, slug, description, meta_title, meta_description,
             og_image, layout, is_homepage
      FROM zv_pages
      WHERE is_active = true
      ORDER BY is_homepage DESC, title ASC
    `.execute(db);
    return c.json({ pages: result.rows });
  });

  // GET /api/pages/:slug — page with hydrated sections
  router.get('/:slug', async (c) => {
    const slug = c.req.param('slug');

    const pageResult = await sql<any>`
      SELECT id::text, title, slug, description, meta_title, meta_description,
             og_image, layout, is_homepage, is_active
      FROM zv_pages
      WHERE slug = ${slug} AND is_active = true
    `.execute(db);

    if (pageResult.rows.length === 0) return c.json({ error: 'Page not found' }, 404);

    const page = pageResult.rows[0];

    const sectionsResult = await sql<any>`
      SELECT id::text, name, type, sort_order, collection, filter_config,
             sort_config, limit_count, fields, slug_field, static_content, style_config
      FROM zv_page_sections
      WHERE page_id = ${page.id} AND is_visible = true
      ORDER BY sort_order ASC
    `.execute(db);

    const hydratedSections = await Promise.all(
      sectionsResult.rows.map(async (section: any) => {
        if (!section.collection) {
          return {
            id: section.id,
            name: section.name,
            type: section.type,
            order: section.sort_order,
            style: section.style_config || {},
            data: section.static_content || {},
          };
        }

        try {
          const collectionExists = await DDLManager.tableExists(db, section.collection);
          if (!collectionExists) {
            return { id: section.id, type: section.type, order: section.sort_order, data: [], error: 'Collection not found' };
          }

          const tableName = DDLManager.getTableName(section.collection);
          let query = (db as any).selectFrom(tableName);

          if (section.fields && section.fields.length > 0) {
            query = query.select(section.fields);
          } else {
            query = query.selectAll();
          }

          const filters = section.filter_config || {};
          for (const [field, value] of Object.entries(filters)) {
            if (typeof value === 'object' && value !== null) {
              const f = value as any;
              if (f.eq !== undefined) query = query.where(field, '=', f.eq);
              if (f.gte !== undefined) query = query.where(field, '>=', f.gte);
              if (f.lte !== undefined) query = query.where(field, '<=', f.lte);
              if (f.like !== undefined) query = query.where(field, 'like', `%${f.like}%`);
              if (f.ne !== undefined) query = query.where(field, '!=', f.ne);
              if (f.in !== undefined && Array.isArray(f.in)) query = query.where(field, 'in', f.in);
            } else {
              query = query.where(field, '=', value);
            }
          }

          for (const sort of (section.sort_config || [])) {
            query = query.orderBy(sort.field, sort.direction || 'asc');
          }

          query = query.limit(Math.min(section.limit_count || 10, 100));
          const data = await query.execute();

          return {
            id: section.id,
            name: section.name,
            type: section.type,
            order: section.sort_order,
            collection: section.collection,
            style: section.style_config || {},
            data,
            count: data.length,
          };
        } catch (error) {
          console.error(`Failed to hydrate section ${section.id}:`, error);
          return { id: section.id, type: section.type, order: section.sort_order, data: [], error: 'Failed to load section data' };
        }
      }),
    );

    return c.json({
      page: {
        id: page.id,
        title: page.title,
        slug: page.slug,
        description: page.description,
        meta_title: page.meta_title || page.title,
        meta_description: page.meta_description || page.description,
        og_image: page.og_image,
        layout: page.layout,
        is_homepage: page.is_homepage,
      },
      sections: hydratedSections,
    });
  });

  // POST /api/pages/:slug/forms/:sectionId — form submission
  router.post('/:slug/forms/:sectionId', async (c) => {
    const slug = c.req.param('slug');
    const sectionId = c.req.param('sectionId');
    const body = await c.req.json().catch(() => ({}));

    const pageResult = await sql<any>`
      SELECT id::text FROM zv_pages WHERE slug = ${slug} AND is_active = true
    `.execute(db);
    if (pageResult.rows.length === 0) return c.json({ error: 'Page not found' }, 404);

    const sectionResult = await sql<any>`
      SELECT id::text FROM zv_page_sections
      WHERE id = ${sectionId} AND page_id = ${pageResult.rows[0].id} AND type = 'form'
    `.execute(db);
    if (sectionResult.rows.length === 0) return c.json({ error: 'Form section not found' }, 404);

    const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
    const submitterEmail = typeof body.email === 'string' ? body.email : null;

    await sql`
      INSERT INTO zv_form_submissions (page_id, section_id, data, submitter_ip, submitter_email)
      VALUES (
        ${pageResult.rows[0].id},
        ${sectionId},
        ${JSON.stringify(body)}::jsonb,
        ${ip},
        ${submitterEmail}
      )
    `.execute(db);

    // Optional notification — ignore if module not present
    try {
      const { notifyRole } = await import('../lib/notifications.js');
      await notifyRole('admin', {
        title: 'New form submission',
        message: `New submission on page "${slug}"`,
        type: 'info',
        source: 'form',
      });
    } catch {}

    return c.json({ success: true, message: 'Form submitted successfully' });
  });

  // GET /api/pages/:slug/:itemSlug — dynamic detail page
  router.get('/:slug/:itemSlug', async (c) => {
    const slug = c.req.param('slug');
    const itemSlug = c.req.param('itemSlug');

    const pageResult = await sql<any>`
      SELECT p.id::text, p.title, p.slug, p.description, p.meta_title, p.meta_description,
             p.og_image, p.layout, p.is_homepage,
             ps.collection, ps.slug_field, ps.fields, ps.filter_config, ps.style_config
      FROM zv_pages p
      JOIN zv_page_sections ps ON ps.page_id = p.id
      WHERE p.slug = ${slug} AND p.is_active = true
        AND ps.slug_field IS NOT NULL
      LIMIT 1
    `.execute(db);

    if (pageResult.rows.length === 0) return c.json({ error: 'Page not found' }, 404);

    const pageConfig = pageResult.rows[0];
    const collectionExists = await DDLManager.tableExists(db, pageConfig.collection);
    if (!collectionExists) return c.json({ error: 'Collection not found' }, 404);

    const tableName = DDLManager.getTableName(pageConfig.collection);
    const itemResult = await (db as any)
      .selectFrom(tableName)
      .selectAll()
      .where(pageConfig.slug_field, '=', itemSlug)
      .executeTakeFirst();

    if (!itemResult) return c.json({ error: 'Item not found' }, 404);

    const otherSections = await sql<any>`
      SELECT id::text, name, type, sort_order, collection, filter_config,
             sort_config, limit_count, fields, static_content, style_config
      FROM zv_page_sections
      WHERE page_id = ${pageConfig.id} AND slug_field IS NULL AND is_visible = true
      ORDER BY sort_order
    `.execute(db);

    const hydratedSections = await Promise.all(
      otherSections.rows.map(async (section: any) => {
        if (!section.collection) {
          return { id: section.id, name: section.name, type: section.type, order: section.sort_order, style: section.style_config || {}, data: section.static_content || {} };
        }
        try {
          const exists = await DDLManager.tableExists(db, section.collection);
          if (!exists) return { id: section.id, type: section.type, order: section.sort_order, data: [] };
          const secTable = DDLManager.getTableName(section.collection);
          let query = (db as any).selectFrom(secTable);
          if (section.fields?.length > 0) query = query.select(section.fields);
          else query = query.selectAll();
          const filters = section.filter_config || {};
          for (const [field, value] of Object.entries(filters)) {
            if (typeof value === 'object' && value !== null) {
              const f = value as any;
              if (f.eq !== undefined) query = query.where(field, '=', f.eq);
              if (f.gte !== undefined) query = query.where(field, '>=', f.gte);
              if (f.lte !== undefined) query = query.where(field, '<=', f.lte);
            } else {
              query = query.where(field, '=', value);
            }
          }
          for (const sort of (section.sort_config || [])) {
            query = query.orderBy(sort.field, sort.direction || 'asc');
          }
          const data = await query.limit(Math.min(section.limit_count || 10, 100)).execute();
          return { id: section.id, name: section.name, type: section.type, order: section.sort_order, collection: section.collection, style: section.style_config || {}, data };
        } catch {
          return { id: section.id, type: section.type, order: section.sort_order, data: [] };
        }
      }),
    );

    return c.json({
      page: {
        id: pageConfig.id,
        title: itemResult[pageConfig.slug_field] || pageConfig.title,
        slug: `${slug}/${itemSlug}`,
        description: pageConfig.description,
        meta_title: itemResult.meta_title || itemResult[pageConfig.slug_field] || pageConfig.title,
        meta_description: itemResult.meta_description || pageConfig.meta_description,
        og_image: itemResult.og_image || pageConfig.og_image,
        layout: pageConfig.layout,
        is_homepage: false,
      },
      item: itemResult,
      sections: hydratedSections,
    });
  });

  return router;
}

// =========================================================
// ADMIN ROUTES — Auth + admin required
// =========================================================
export function adminPagesRoutes(db: Database, auth: any): Hono {
  const router = new Hono();

  async function requireSession(c: any) {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return null;
    return session;
  }

  async function requireAdmin(c: any) {
    const session = await requireSession(c);
    if (!session) return null;
    const isAdmin = await checkPermission(session.user.id, 'admin', '*');
    if (!isAdmin) return null;
    return session;
  }

  // GET /api/admin/pages
  router.get('/', async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    const result = await sql<any>`
      SELECT p.id::text, p.title, p.slug, p.description, p.is_active, p.is_homepage,
             p.layout, p.meta_title, p.meta_description, p.og_image,
             p.created_at, p.updated_at,
             COUNT(ps.id)::int as section_count
      FROM zv_pages p
      LEFT JOIN zv_page_sections ps ON ps.page_id = p.id
      GROUP BY p.id
      ORDER BY p.is_homepage DESC, p.title ASC
    `.execute(db);

    return c.json({ pages: result.rows });
  });

  // GET /api/admin/pages/collections/list — available collections
  // Must be before /:id to avoid routing conflict
  router.get('/collections/list', async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    const collections = await DDLManager.getCollections(db);
    return c.json({ collections });
  });

  // GET /api/admin/pages/:id
  router.get('/:id', async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    const id = c.req.param('id');

    const page = await sql<any>`
      SELECT id::text, title, slug, description, meta_title, meta_description, og_image,
             is_active, is_homepage, layout, created_at, updated_at
      FROM zv_pages WHERE id = ${id}
    `.execute(db);
    if (!page.rows[0]) return c.json({ error: 'Not found' }, 404);

    const sections = await sql<any>`
      SELECT id::text, page_id, name, type, sort_order, is_visible,
             collection, filter_config, sort_config, limit_count, fields,
             slug_field, static_content, style_config
      FROM zv_page_sections WHERE page_id = ${id} ORDER BY sort_order
    `.execute(db);

    return c.json({ page: page.rows[0], sections: sections.rows });
  });

  // POST /api/admin/pages
  router.post('/', async (c) => {
    const session = await requireAdmin(c);
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    const data = await c.req.json();
    if (!data.title) return c.json({ error: 'title is required' }, 400);

    if (!data.slug) {
      data.slug = data.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.slug)) {
      return c.json({ error: 'Slug must be lowercase alphanumeric with hyphens' }, 400);
    }

    if (data.is_homepage) {
      await sql`UPDATE zv_pages SET is_homepage = false WHERE is_homepage = true`.execute(db);
    }

    const result = await sql<{ id: string }>`
      INSERT INTO zv_pages (title, slug, description, meta_title, meta_description, og_image, is_active, is_homepage, layout, created_by)
      VALUES (${data.title}, ${data.slug}, ${data.description || null},
              ${data.meta_title || null}, ${data.meta_description || null},
              ${data.og_image || null}, ${data.is_active ?? true},
              ${data.is_homepage ?? false}, ${data.layout || 'default'}, ${session.user.id})
      RETURNING id::text
    `.execute(db);

    return c.json({ id: result.rows[0].id }, 201);
  });

  // PUT /api/admin/pages/:id
  router.put('/:id', async (c) => {
    const session = await requireAdmin(c);
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    const id = c.req.param('id');
    const data = await c.req.json();

    if (data.is_homepage) {
      await sql`UPDATE zv_pages SET is_homepage = false WHERE is_homepage = true`.execute(db);
    }

    const allowed = ['title', 'slug', 'description', 'meta_title', 'meta_description', 'og_image', 'is_active', 'is_homepage', 'layout'];
    const updates: Record<string, any> = { updated_at: new Date() };
    for (const field of allowed) {
      if (data[field] !== undefined) updates[field] = data[field];
    }

    if (Object.keys(updates).length > 1) {
      await (db as any).updateTable('zv_pages').set(updates).where('id', '=', id).execute();
    }

    return c.json({ success: true });
  });

  // DELETE /api/admin/pages/:id
  router.delete('/:id', async (c) => {
    const session = await requireAdmin(c);
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    await sql`DELETE FROM zv_pages WHERE id = ${c.req.param('id')}`.execute(db);
    return c.json({ success: true });
  });

  // POST /api/admin/pages/:id/sections/reorder — must be before /:id/sections/:sectionId
  router.post('/:id/sections/reorder', async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    const { order } = await c.req.json();
    if (!Array.isArray(order)) return c.json({ error: 'order must be an array' }, 400);

    for (const item of order) {
      await sql`
        UPDATE zv_page_sections
        SET sort_order = ${item.sort_order}, updated_at = NOW()
        WHERE id = ${item.id}
      `.execute(db);
    }
    return c.json({ success: true });
  });

  // POST /api/admin/pages/:id/sections
  router.post('/:id/sections', async (c) => {
    const session = await requireAdmin(c);
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    const pageId = c.req.param('id');
    const data = await c.req.json();

    if (!data.name) return c.json({ error: 'name is required' }, 400);
    if (!data.type) return c.json({ error: 'type is required' }, 400);

    let sortOrder = data.sort_order;
    if (sortOrder === undefined) {
      const maxOrder = await sql<{ max: number }>`
        SELECT COALESCE(MAX(sort_order), -1) as max FROM zv_page_sections WHERE page_id = ${pageId}
      `.execute(db);
      sortOrder = maxOrder.rows[0].max + 1;
    }

    const result = await sql<{ id: string }>`
      INSERT INTO zv_page_sections (
        page_id, name, type, sort_order, is_visible, collection, filter_config,
        sort_config, limit_count, fields, slug_field, static_content, style_config
      ) VALUES (
        ${pageId}, ${data.name}, ${data.type},
        ${sortOrder},
        ${data.is_visible ?? true},
        ${data.collection || null},
        ${JSON.stringify(data.filter_config || {})}::jsonb,
        ${JSON.stringify(data.sort_config || [])}::jsonb,
        ${data.limit_count || 10},
        ${data.fields || null}::text[],
        ${data.slug_field || null},
        ${JSON.stringify(data.static_content || {})}::jsonb,
        ${JSON.stringify(data.style_config || {})}::jsonb
      )
      RETURNING id::text
    `.execute(db);

    return c.json({ id: result.rows[0].id }, 201);
  });

  // PUT /api/admin/pages/:id/sections/:sectionId
  router.put('/:id/sections/:sectionId', async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    const sectionId = c.req.param('sectionId');
    const data = await c.req.json();

    const updates: Record<string, any> = {};

    // Scalar fields
    for (const field of ['name', 'type', 'collection', 'slug_field', 'sort_order', 'limit_count', 'is_visible']) {
      if (data[field] !== undefined) updates[field] = data[field];
    }

    // JSONB fields — use sql template for proper casting
    for (const field of ['filter_config', 'sort_config', 'static_content', 'style_config']) {
      if (data[field] !== undefined) {
        updates[field] = sql`${JSON.stringify(data[field])}::jsonb`;
      }
    }

    // text[] field
    if (data.fields !== undefined) {
      updates.fields = sql`${JSON.stringify(data.fields)}::text[]`;
    }

    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date();
      await (db as any)
        .updateTable('zv_page_sections')
        .set(updates)
        .where('id', '=', sectionId)
        .execute();
    }

    return c.json({ success: true });
  });

  // DELETE /api/admin/pages/:id/sections/:sectionId
  router.delete('/:id/sections/:sectionId', async (c) => {
    const session = await requireSession(c);
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    await sql`DELETE FROM zv_page_sections WHERE id = ${c.req.param('sectionId')}`.execute(db);
    return c.json({ success: true });
  });

  return router;
}
