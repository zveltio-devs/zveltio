/**
 * Portal Routes — /api/portal/*
 *
 * Manages portal theme, pages, sections, and collection views.
 * All endpoints respect multi-tenancy via tenantMiddleware (c.get('tenant')).
 *
 * Admin endpoints (require god/admin role):
 *   GET    /api/portal/theme
 *   PUT    /api/portal/theme
 *   GET    /api/portal/pages
 *   POST   /api/portal/pages
 *   PUT    /api/portal/pages/:id
 *   DELETE /api/portal/pages/:id
 *   GET    /api/portal/pages/:id/sections
 *   POST   /api/portal/pages/:id/sections
 *   PUT    /api/portal/sections/:id
 *   DELETE /api/portal/sections/:id
 *   POST   /api/portal/sections/reorder
 *   GET    /api/portal/collections/:name/views
 *   POST   /api/portal/collections/:name/views
 *   PUT    /api/portal/collections/:name/views/:id
 *   DELETE /api/portal/collections/:name/views/:id
 *
 * Public render endpoints (no auth required — honor page.auth_required):
 *   GET    /api/portal/render          → navigation + theme
 *   GET    /api/portal/render/:slug    → page + sections + resolved data
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { checkPermission } from '../lib/permissions.js';

// ── Zod schemas ───────────────────────────────────────────────────────────────

const HEX_COLOR = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const ThemeSchema = z.object({
  app_name:         z.string().min(1).max(100).optional(),
  logo_url:         z.string().url().nullable().optional(),
  favicon_url:      z.string().url().nullable().optional(),
  color_primary:    HEX_COLOR.optional(),
  color_secondary:  HEX_COLOR.optional(),
  color_accent:     HEX_COLOR.optional(),
  color_neutral:    HEX_COLOR.optional(),
  color_base_100:   HEX_COLOR.optional(),
  color_base_200:   HEX_COLOR.optional(),
  color_base_300:   HEX_COLOR.optional(),
  font_family:      z.string().max(200).optional(),
  font_size_base:   z.string().regex(/^\d+(\.\d+)?(px|rem|em)$/).optional(),
  border_radius:    z.string().max(20).optional(),
  color_scheme:     z.enum(['light', 'dark', 'auto']).optional(),
  custom_css:       z.string().max(50_000).nullable().optional(),
  nav_position:     z.enum(['top', 'sidebar', 'none']).optional(),
  footer_text:      z.string().max(500).nullable().optional(),
  meta_title:       z.string().max(200).nullable().optional(),
  meta_description: z.string().max(500).nullable().optional(),
});

const PageCreateSchema = z.object({
  slug:          z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
  title:         z.string().min(1).max(200),
  icon:          z.string().max(50).optional(),
  is_active:     z.boolean().optional(),
  is_homepage:   z.boolean().optional(),
  auth_required: z.boolean().optional(),
  allowed_roles: z.array(z.string()).optional(),
  parent_id:     z.string().uuid().nullable().optional(),
  sort_order:    z.number().int().min(0).optional(),
});

const PageUpdateSchema = PageCreateSchema.partial();

const VIEW_TYPES = ['table', 'detail', 'form', 'kanban', 'calendar', 'gallery', 'stats', 'chart', 'rich-text', 'map', 'custom'] as const;

const SectionCreateSchema = z.object({
  view_type:          z.enum(VIEW_TYPES),
  title:              z.string().max(200).optional(),
  collection:         z.string().max(100).optional(),
  collection_view_id: z.string().uuid().nullable().optional(),
  config:             z.record(z.string(), z.unknown()).optional(),
  sort_order:         z.number().int().min(0).optional(),
  col_span:           z.number().int().min(1).max(12).optional(),
  is_visible:         z.boolean().optional(),
});

const SectionUpdateSchema = SectionCreateSchema.partial();

const ReorderSchema = z.object({
  page_id: z.string().uuid().optional(),
  ids:     z.array(z.string().uuid()).min(1),
});

const COLLECTION_VIEW_TYPES = ['table', 'kanban', 'calendar', 'gallery', 'stats', 'chart', 'map'] as const;

const CollectionViewCreateSchema = z.object({
  name:       z.string().min(1).max(100),
  view_type:  z.enum(COLLECTION_VIEW_TYPES),
  config:     z.record(z.string(), z.unknown()).optional(),
  is_default: z.boolean().optional(),
});

const CollectionViewUpdateSchema = CollectionViewCreateSchema.partial();

// ── Helper ────────────────────────────────────────────────────────────────────

function tenantFilter(tenantId: string | null) {
  return tenantId === null
    ? sql<boolean>`tenant_id IS NULL`
    : sql<boolean>`tenant_id = ${tenantId}::uuid`;
}

async function requireAdmin(c: any): Promise<Response | null> {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const allowed = await checkPermission(user.id, 'portal', 'manage').catch(() => false);
  if (!allowed && user.role !== 'god' && user.role !== 'admin') {
    return c.json({ error: 'Forbidden' }, 403);
  }
  return null;
}

// ── Route factory ─────────────────────────────────────────────────────────────

export function portalRoutes(db: Database, auth: any) {
  const app = new Hono();

  // ── Theme ─────────────────────────────────────────────────────────────────

  /** GET /api/portal/theme — public (used by portal renderer) */
  app.get('/theme', async (c) => {
    const tenant = c.get('tenant');
    const tenantId = tenant?.id ?? null;
    const rows = await db
      .selectFrom('zvd_portal_theme as t')
      .selectAll()
      .where(tenantFilter(tenantId))
      .limit(1)
      .execute();

    if (rows.length === 0) {
      return c.json({ theme: { app_name: 'My App', color_scheme: 'auto', border_radius: '0.5rem' } });
    }
    return c.json({ theme: rows[0] });
  });

  /** PUT /api/portal/theme — admin only */
  app.put('/theme', zValidator('json', ThemeSchema), async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const tenant = c.get('tenant');
    const tenantId = tenant?.id ?? null;
    const data = c.req.valid('json');

    const existing = await db
      .selectFrom('zvd_portal_theme')
      .select('id')
      .where(tenantFilter(tenantId))
      .limit(1)
      .execute();

    if (existing.length === 0) {
      const row = await db
        .insertInto('zvd_portal_theme' as any)
        .values({ tenant_id: tenantId, ...data, updated_at: new Date() })
        .returningAll()
        .executeTakeFirstOrThrow();
      return c.json({ theme: row });
    }

    const row = await db
      .updateTable('zvd_portal_theme' as any)
      .set({ ...data, updated_at: new Date() })
      .where(tenantFilter(tenantId))
      .returningAll()
      .executeTakeFirstOrThrow();
    return c.json({ theme: row });
  });

  // ── Pages ─────────────────────────────────────────────────────────────────

  /** GET /api/portal/pages */
  app.get('/pages', async (c) => {
    const tenant = c.get('tenant');
    const tenantId = tenant?.id ?? null;
    const includeInactive = c.req.query('include_inactive') === 'true';

    let query = db
      .selectFrom('zvd_portal_pages as p')
      .selectAll()
      .where(tenantFilter(tenantId))
      .orderBy('sort_order asc')
      .orderBy('created_at asc');

    if (!includeInactive) {
      query = query.where('p.is_active', '=', true);
    }

    const pages = await query.execute();
    return c.json({ pages, total: pages.length });
  });

  /** POST /api/portal/pages — admin only */
  app.post('/pages', zValidator('json', PageCreateSchema), async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const tenant = c.get('tenant');
    const tenantId = tenant?.id ?? null;
    const data = c.req.valid('json');

    // If setting as homepage, unset existing homepage
    if (data.is_homepage) {
      await db
        .updateTable('zvd_portal_pages' as any)
        .set({ is_homepage: false })
        .where(tenantFilter(tenantId))
        .where('is_homepage', '=', true)
        .execute();
    }

    const page = await db
      .insertInto('zvd_portal_pages' as any)
      .values({
        tenant_id:     tenantId,
        slug:          data.slug,
        title:         data.title,
        icon:          data.icon ?? null,
        is_active:     data.is_active ?? true,
        is_homepage:   data.is_homepage ?? false,
        auth_required: data.auth_required ?? false,
        allowed_roles: data.allowed_roles ?? [],
        parent_id:     data.parent_id ?? null,
        sort_order:    data.sort_order ?? 0,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return c.json({ page }, 201);
  });

  /** PUT /api/portal/pages/:id — admin only */
  app.put('/pages/:id', zValidator('json', PageUpdateSchema), async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const tenant = c.get('tenant');
    const tenantId = tenant?.id ?? null;
    const { id } = c.req.param();
    const data = c.req.valid('json');

    if (data.is_homepage) {
      await db
        .updateTable('zvd_portal_pages' as any)
        .set({ is_homepage: false })
        .where(tenantFilter(tenantId))
        .where('is_homepage', '=', true)
        .execute();
    }

    const page = await db
      .updateTable('zvd_portal_pages' as any)
      .set({ ...data, updated_at: new Date() })
      .where('id', '=', id)
      .where(tenantFilter(tenantId))
      .returningAll()
      .executeTakeFirst();

    if (!page) return c.json({ error: 'Page not found' }, 404);
    return c.json({ page });
  });

  /** DELETE /api/portal/pages/:id — admin only */
  app.delete('/pages/:id', async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const tenant = c.get('tenant');
    const tenantId = tenant?.id ?? null;
    const { id } = c.req.param();

    await db
      .deleteFrom('zvd_portal_pages' as any)
      .where('id', '=', id)
      .where(tenantFilter(tenantId))
      .execute();

    return c.json({ success: true });
  });

  // ── Sections ──────────────────────────────────────────────────────────────

  /** GET /api/portal/pages/:id/sections */
  app.get('/pages/:id/sections', async (c) => {
    const tenant = c.get('tenant');
    const tenantId = tenant?.id ?? null;
    const { id } = c.req.param();

    const sections = await db
      .selectFrom('zvd_portal_sections as s')
      .selectAll()
      .where('s.page_id', '=', id)
      .where(tenantFilter(tenantId))
      .orderBy('s.sort_order asc')
      .execute();

    return c.json({ sections });
  });

  /** POST /api/portal/pages/:id/sections — admin only */
  app.post('/pages/:id/sections', zValidator('json', SectionCreateSchema), async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const tenant = c.get('tenant');
    const tenantId = tenant?.id ?? null;
    const { id: pageId } = c.req.param();
    const data = c.req.valid('json');

    // Verify page belongs to this tenant
    const page = await db
      .selectFrom('zvd_portal_pages')
      .select('id')
      .where('id', '=', pageId)
      .where(tenantFilter(tenantId))
      .executeTakeFirst();
    if (!page) return c.json({ error: 'Page not found' }, 404);

    const section = await db
      .insertInto('zvd_portal_sections' as any)
      .values({
        tenant_id:  tenantId,
        page_id:    pageId,
        view_type:  data.view_type,
        title:      data.title ?? null,
        collection:          data.collection ?? null,
        collection_view_id:  data.collection_view_id ?? null,
        config:              JSON.stringify(data.config ?? {}),
        sort_order:          data.sort_order ?? 0,
        col_span:            data.col_span ?? 12,
        is_visible:          data.is_visible ?? true,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return c.json({ section }, 201);
  });

  /** PUT /api/portal/sections/:id — admin only */
  app.put('/sections/:id', zValidator('json', SectionUpdateSchema), async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const tenant = c.get('tenant');
    const tenantId = tenant?.id ?? null;
    const { id } = c.req.param();
    const data = c.req.valid('json');

    const update: Record<string, unknown> = { ...data, updated_at: new Date() };
    if (data.config !== undefined) update.config = JSON.stringify(data.config);

    const section = await db
      .updateTable('zvd_portal_sections' as any)
      .set(update)
      .where('id', '=', id)
      .where(tenantFilter(tenantId))
      .returningAll()
      .executeTakeFirst();

    if (!section) return c.json({ error: 'Section not found' }, 404);
    return c.json({ section });
  });

  /** DELETE /api/portal/sections/:id — admin only */
  app.delete('/sections/:id', async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const tenant = c.get('tenant');
    const tenantId = tenant?.id ?? null;
    const { id } = c.req.param();

    await db
      .deleteFrom('zvd_portal_sections' as any)
      .where('id', '=', id)
      .where(tenantFilter(tenantId))
      .execute();

    return c.json({ success: true });
  });

  /** POST /api/portal/sections/reorder — admin only */
  app.post('/sections/reorder', zValidator('json', ReorderSchema), async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const tenant = c.get('tenant');
    const tenantId = tenant?.id ?? null;
    const { ids } = c.req.valid('json');

    await Promise.all(
      ids.map((id, index) =>
        db
          .updateTable('zvd_portal_sections' as any)
          .set({ sort_order: index })
          .where('id', '=', id)
          .where(tenantFilter(tenantId))
          .execute(),
      ),
    );

    return c.json({ success: true });
  });

  // ── Collection Views ──────────────────────────────────────────────────────

  /** GET /api/portal/collections/:name/views */
  app.get('/collections/:name/views', async (c) => {
    const tenant = c.get('tenant');
    const tenantId = tenant?.id ?? null;
    const { name } = c.req.param();

    const views = await db
      .selectFrom('zvd_collection_views as v')
      .selectAll()
      .where('v.collection', '=', name)
      .where(tenantFilter(tenantId))
      .orderBy('v.is_default desc')
      .orderBy('v.created_at asc')
      .execute();

    return c.json({ views });
  });

  /** POST /api/portal/collections/:name/views — admin only */
  app.post('/collections/:name/views', zValidator('json', CollectionViewCreateSchema), async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const tenant = c.get('tenant');
    const tenantId = tenant?.id ?? null;
    const { name } = c.req.param();
    const data = c.req.valid('json');
    const user = c.get('user');

    // If setting as default, clear existing default
    if (data.is_default) {
      await db
        .updateTable('zvd_collection_views' as any)
        .set({ is_default: false })
        .where('collection', '=', name)
        .where('is_default', '=', true)
        .where(tenantFilter(tenantId))
        .execute();
    }

    const view = await db
      .insertInto('zvd_collection_views' as any)
      .values({
        tenant_id:  tenantId,
        collection: name,
        name:       data.name,
        view_type:  data.view_type,
        config:     JSON.stringify(data.config ?? {}),
        is_default: data.is_default ?? false,
        created_by: user?.id ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return c.json({ view }, 201);
  });

  /** PUT /api/portal/collections/:name/views/:id — admin only */
  app.put('/collections/:name/views/:id', zValidator('json', CollectionViewUpdateSchema), async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const tenant = c.get('tenant');
    const tenantId = tenant?.id ?? null;
    const { name, id } = c.req.param();
    const data = c.req.valid('json');

    if (data.is_default) {
      await db
        .updateTable('zvd_collection_views' as any)
        .set({ is_default: false })
        .where('collection', '=', name)
        .where('is_default', '=', true)
        .where('id', '!=', id)
        .where(tenantFilter(tenantId))
        .execute();
    }

    const update: Record<string, unknown> = { ...data, updated_at: new Date() };
    if (data.config !== undefined) update.config = JSON.stringify(data.config);

    const view = await db
      .updateTable('zvd_collection_views' as any)
      .set(update)
      .where('id', '=', id)
      .where('collection', '=', name)
      .where(tenantFilter(tenantId))
      .returningAll()
      .executeTakeFirst();

    if (!view) return c.json({ error: 'View not found' }, 404);
    return c.json({ view });
  });

  /** DELETE /api/portal/collections/:name/views/:id — admin only */
  app.delete('/collections/:name/views/:id', async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const tenant = c.get('tenant');
    const tenantId = tenant?.id ?? null;
    const { name, id } = c.req.param();

    await db
      .deleteFrom('zvd_collection_views' as any)
      .where('id', '=', id)
      .where('collection', '=', name)
      .where(tenantFilter(tenantId))
      .execute();

    return c.json({ success: true });
  });

  // ── Shortcut: update/delete collection view by ID only (no collection in path) ──

  /** PUT /api/portal/views/:id */
  app.put('/views/:id', zValidator('json', CollectionViewUpdateSchema), async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const tenant = c.get('tenant');
    const tenantId = tenant?.id ?? null;
    const { id } = c.req.param();
    const data = c.req.valid('json');

    const update: Record<string, unknown> = { ...data, updated_at: new Date() };
    if (data.config !== undefined) update.config = JSON.stringify(data.config);

    const view = await db
      .updateTable('zvd_collection_views' as any)
      .set(update)
      .where('id', '=', id)
      .where(tenantFilter(tenantId))
      .returningAll()
      .executeTakeFirst();

    if (!view) return c.json({ error: 'View not found' }, 404);
    return c.json({ view });
  });

  /** DELETE /api/portal/views/:id */
  app.delete('/views/:id', async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const tenant = c.get('tenant');
    const tenantId = tenant?.id ?? null;
    const { id } = c.req.param();

    await db
      .deleteFrom('zvd_collection_views' as any)
      .where('id', '=', id)
      .where(tenantFilter(tenantId))
      .execute();

    return c.json({ success: true });
  });

  // ── Public Render API ─────────────────────────────────────────────────────
  // Used by the portal renderer (packages/client) to fetch navigation + page data.

  /** GET /api/portal/render — navigation tree + theme (always public) */
  app.get('/render', async (c) => {
    const tenant = c.get('tenant');
    const tenantId = tenant?.id ?? null;

    const [theme, pages] = await Promise.all([
      db
        .selectFrom('zvd_portal_theme')
        .selectAll()
        .where(tenantFilter(tenantId))
        .limit(1)
        .executeTakeFirst(),
      db
        .selectFrom('zvd_portal_pages as p')
        .selectAll()
        .where('p.is_active', '=', true)
        .where(tenantFilter(tenantId))
        .orderBy('p.sort_order asc')
        .execute(),
    ]);

    // Build navigation tree (parent → children)
    const roots = pages.filter((p: any) => !p.parent_id);
    const tree = roots.map((p: any) => ({
      ...p,
      children: pages.filter((c: any) => c.parent_id === p.id),
    }));

    return c.json({
      theme: theme ?? { app_name: 'My App', color_scheme: 'auto' },
      nav: tree,
    });
  });

  /** GET /api/portal/render/:slug — page + sections (respects auth_required) */
  app.get('/render/:slug', async (c) => {
    const tenant = c.get('tenant');
    const tenantId = tenant?.id ?? null;
    const { slug } = c.req.param();

    const page = await db
      .selectFrom('zvd_portal_pages as p')
      .selectAll()
      .where('p.slug', '=', slug)
      .where('p.is_active', '=', true)
      .where(tenantFilter(tenantId))
      .executeTakeFirst();

    if (!page) return c.json({ error: 'Page not found' }, 404);

    // Auth check for protected pages
    if ((page as any).auth_required) {
      const user = c.get('user');
      if (!user) return c.json({ error: 'Authentication required' }, 401);
      const roles = (page as any).allowed_roles as string[];
      if (roles.length > 0 && !roles.includes(user.role)) {
        return c.json({ error: 'Insufficient role' }, 403);
      }
    }

    const sections = await db
      .selectFrom('zvd_portal_sections as s')
      .selectAll()
      .where('s.page_id', '=', (page as any).id)
      .where(tenantFilter(tenantId))
      .orderBy('s.sort_order asc')
      .execute();

    return c.json({ page, sections });
  });

  return app;
}
