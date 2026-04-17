/**
 * Zones / Pages / Views Routes — /api/zones + /api/views
 *
 * Implements the 3-layer portal architecture:
 *   Layer 1: Views  — atomic reusable blocks (collection + render config)
 *   Layer 2: Pages  — containers of views, belong to a Zone
 *   Layer 3: Zones  — complete portals (Client, Intranet, etc.)
 *
 * Admin endpoints (require admin role):
 *   GET    /api/zones                              → list zones
 *   POST   /api/zones                             → create zone
 *   GET    /api/zones/:slug                        → zone details
 *   PUT    /api/zones/:slug                        → update zone
 *   DELETE /api/zones/:slug                        → delete zone
 *
 *   GET    /api/zones/:slug/pages                  → pages in zone
 *   POST   /api/zones/:slug/pages                  → add page to zone
 *   PUT    /api/zones/:slug/pages/:pageSlug        → update page
 *   DELETE /api/zones/:slug/pages/:pageSlug        → delete page
 *   POST   /api/zones/:slug/pages/reorder          → reorder pages
 *
 *   GET    /api/zones/:slug/pages/:pageSlug/views  → views on a page
 *   POST   /api/zones/:slug/pages/:pageSlug/views  → add view to page
 *   DELETE /api/zones/:slug/pages/:pageSlug/views/:viewId → remove view from page
 *   PUT    /api/zones/:slug/pages/:pageSlug/views/reorder → reorder views
 *
 *   GET    /api/views                              → all views (paginated)
 *   POST   /api/views                             → create view
 *   GET    /api/views/:id                          → view details
 *   PUT    /api/views/:id                          → update view
 *   DELETE /api/views/:id                          → delete view
 *
 * Public render endpoints (respects auth_required + access_roles):
 *   GET    /api/zones/:slug/render                 → nav + zone theme
 *   GET    /api/zones/:slug/render/:pageSlug       → page + resolved views + data
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { checkPermission } from '../lib/permissions.js';
import { zoneRenderRequests, zoneAccessDenied, viewQueryDuration } from '../lib/telemetry.js';

// ── Zod schemas ───────────────────────────────────────────────────────────────

const ZoneCreateSchema = z.object({
  name:             z.string().min(1).max(100),
  slug:             z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
  description:      z.string().max(500).optional(),
  is_active:        z.boolean().optional(),
  access_roles:     z.array(z.string()).optional(),
  base_path:        z.string().min(1).max(200),
  site_name:        z.string().max(100).nullable().optional(),
  site_logo_url:    z.string().url().nullable().optional(),
  primary_color:    z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  secondary_color:  z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  custom_css:       z.string().max(50_000).nullable().optional(),
  nav_position:     z.enum(['sidebar', 'topbar', 'both']).optional(),
  show_breadcrumbs: z.boolean().optional(),
});

const ZoneUpdateSchema = ZoneCreateSchema.partial();

const PageCreateSchema = z.object({
  title:         z.string().min(1).max(200),
  slug:          z.string().min(1).max(100).regex(/^[a-z0-9/-]+$/),
  icon:          z.string().max(50).optional(),
  description:   z.string().max(500).optional(),
  is_active:     z.boolean().optional(),
  is_homepage:   z.boolean().optional(),
  auth_required: z.boolean().optional(),
  allowed_roles: z.array(z.string()).optional(),
  parent_id:     z.string().uuid().nullable().optional(),
  sort_order:    z.number().int().min(0).optional(),
});

const PageUpdateSchema = PageCreateSchema.partial();

const ReorderSchema = z.object({
  ids: z.array(z.string().uuid()).min(1),
});

const ViewCreateSchema = z.object({
  name:        z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  collection:  z.string().min(1).max(100),
  view_type:   z.enum(['table', 'kanban', 'calendar', 'gallery', 'stats', 'chart', 'list', 'timeline']),
  fields:      z.array(z.record(z.string(), z.unknown())).optional(),
  filters:     z.array(z.record(z.string(), z.unknown())).optional(),
  sort_field:  z.string().optional(),
  sort_dir:    z.enum(['asc', 'desc']).optional(),
  page_size:   z.number().int().min(1).max(500).optional(),
  config:      z.record(z.string(), z.unknown()).optional(),
  is_public:   z.boolean().optional(),
});

const ViewUpdateSchema = ViewCreateSchema.partial();

const PageViewAddSchema = z.object({
  view_id:        z.string().uuid(),
  title_override: z.string().max(200).nullable().optional(),
  col_span:       z.number().int().min(1).max(12).optional(),
  sort_order:     z.number().int().min(0).optional(),
  config_override: z.record(z.string(), z.unknown()).optional(),
});

// ── Helper ────────────────────────────────────────────────────────────────────

async function requireAdmin(c: any): Promise<Response | null> {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const allowed = await checkPermission(user.id, 'admin', '*').catch(() => false);
  if (!allowed) return c.json({ error: 'Forbidden' }, 403);
  return null;
}

// ── Route factory ─────────────────────────────────────────────────────────────

export function zonesRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // Auth middleware — inject user from session
  app.use('*', async (c, next) => {
    try {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (session?.user) {
        // Better-Auth session user doesn't include `role` by default — hydrate from DB
        const row = await (db as any)
          .selectFrom('user')
          .select(['role'])
          .where('id', '=', session.user.id)
          .executeTakeFirst();
        c.set('user', { ...session.user, role: row?.role ?? (session.user as any).role });
      }
    } catch {
      // Public endpoints (render) work without auth
    }
    await next();
  });

  // ── Zones ─────────────────────────────────────────────────────────────────

  /** GET /api/zones */
  app.get('/', async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const zones = await db
      .selectFrom('zvd_zones')
      .selectAll()
      .orderBy('name asc')
      .execute();

    return c.json({ zones });
  });

  /** POST /api/zones */
  app.post('/', zValidator('json', ZoneCreateSchema), async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const data = c.req.valid('json');

    const zone = await db
      .insertInto('zvd_zones')
      .values({
        name:             data.name,
        slug:             data.slug,
        description:      data.description ?? null,
        is_active:        data.is_active ?? false,
        access_roles:     data.access_roles ?? [],
        base_path:        data.base_path,
        site_name:        data.site_name ?? null,
        site_logo_url:    data.site_logo_url ?? null,
        primary_color:    data.primary_color ?? '#069494',
        secondary_color:  data.secondary_color ?? null,
        custom_css:       data.custom_css ?? null,
        nav_position:     data.nav_position ?? 'sidebar',
        show_breadcrumbs: data.show_breadcrumbs ?? true,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return c.json({ zone }, 201);
  });

  /** GET /api/zones/:slug */
  app.get('/:slug', async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const zone = await db
      .selectFrom('zvd_zones')
      .selectAll()
      .where('slug', '=', c.req.param('slug'))
      .executeTakeFirst();

    if (!zone) return c.json({ error: 'Zone not found' }, 404);
    return c.json({ zone });
  });

  /** PUT /api/zones/:slug */
  app.put('/:slug', zValidator('json', ZoneUpdateSchema), async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const data = c.req.valid('json');
    const zone = await db
      .updateTable('zvd_zones')
      .set({ ...data, updated_at: new Date() })
      .where('slug', '=', c.req.param('slug'))
      .returningAll()
      .executeTakeFirst();

    if (!zone) return c.json({ error: 'Zone not found' }, 404);
    return c.json({ zone });
  });

  /** DELETE /api/zones/:slug */
  app.delete('/:slug', async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    await db
      .deleteFrom('zvd_zones')
      .where('slug', '=', c.req.param('slug'))
      .execute();

    return c.json({ success: true });
  });

  // ── Pages in a Zone ───────────────────────────────────────────────────────

  /** GET /api/zones/:slug/pages */
  app.get('/:slug/pages', async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const zone = await db
      .selectFrom('zvd_zones')
      .select('id')
      .where('slug', '=', c.req.param('slug'))
      .executeTakeFirst();

    if (!zone) return c.json({ error: 'Zone not found' }, 404);

    const pages = await db
      .selectFrom('zvd_pages')
      .selectAll()
      .where('zone_id', '=', zone.id)
      .orderBy('sort_order asc')
      .orderBy('created_at asc')
      .execute();

    return c.json({ pages });
  });

  /** POST /api/zones/:slug/pages */
  app.post('/:slug/pages', zValidator('json', PageCreateSchema), async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const zone = await db
      .selectFrom('zvd_zones')
      .select('id')
      .where('slug', '=', c.req.param('slug'))
      .executeTakeFirst();

    if (!zone) return c.json({ error: 'Zone not found' }, 404);

    const data = c.req.valid('json');

    if (data.is_homepage) {
      await db
        .updateTable('zvd_pages')
        .set({ is_homepage: false })
        .where('zone_id', '=', zone.id)
        .where('is_homepage', '=', true)
        .execute();
    }

    const page = await db
      .insertInto('zvd_pages')
      .values({
        zone_id:       zone.id,
        title:         data.title,
        slug:          data.slug,
        icon:          data.icon ?? null,
        description:   data.description ?? null,
        is_active:     data.is_active ?? true,
        is_homepage:   data.is_homepage ?? false,
        auth_required: data.auth_required ?? true,
        allowed_roles: data.allowed_roles ?? [],
        parent_id:     data.parent_id ?? null,
        sort_order:    data.sort_order ?? 0,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return c.json({ page }, 201);
  });

  /** PUT /api/zones/:slug/pages/:pageSlug */
  app.put('/:slug/pages/:pageSlug', zValidator('json', PageUpdateSchema), async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const zone = await db
      .selectFrom('zvd_zones')
      .select('id')
      .where('slug', '=', c.req.param('slug'))
      .executeTakeFirst();

    if (!zone) return c.json({ error: 'Zone not found' }, 404);

    const data = c.req.valid('json');

    if (data.is_homepage) {
      await db
        .updateTable('zvd_pages')
        .set({ is_homepage: false })
        .where('zone_id', '=', zone.id)
        .where('is_homepage', '=', true)
        .execute();
    }

    const page = await db
      .updateTable('zvd_pages')
      .set({ ...data, updated_at: new Date() })
      .where('zone_id', '=', zone.id)
      .where('slug', '=', c.req.param('pageSlug'))
      .returningAll()
      .executeTakeFirst();

    if (!page) return c.json({ error: 'Page not found' }, 404);
    return c.json({ page });
  });

  /** DELETE /api/zones/:slug/pages/:pageSlug */
  app.delete('/:slug/pages/:pageSlug', async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const zone = await db
      .selectFrom('zvd_zones')
      .select('id')
      .where('slug', '=', c.req.param('slug'))
      .executeTakeFirst();

    if (!zone) return c.json({ error: 'Zone not found' }, 404);

    await db
      .deleteFrom('zvd_pages')
      .where('zone_id', '=', zone.id)
      .where('slug', '=', c.req.param('pageSlug'))
      .execute();

    return c.json({ success: true });
  });

  /** POST /api/zones/:slug/pages/reorder */
  app.post('/:slug/pages/reorder', zValidator('json', ReorderSchema), async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const { ids } = c.req.valid('json');

    await Promise.all(
      ids.map((id, index) =>
        db
          .updateTable('zvd_pages')
          .set({ sort_order: index })
          .where('id', '=', id)
          .execute(),
      ),
    );

    return c.json({ success: true });
  });

  // ── Views on a Page ───────────────────────────────────────────────────────

  /** GET /api/zones/:slug/pages/:pageSlug/views */
  app.get('/:slug/pages/:pageSlug/views', async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const page = await db
      .selectFrom('zvd_pages as p')
      .innerJoin('zvd_zones as z', 'z.id', 'p.zone_id')
      .select('p.id')
      .where('z.slug', '=', c.req.param('slug'))
      .where('p.slug', '=', c.req.param('pageSlug'))
      .executeTakeFirst();

    if (!page) return c.json({ error: 'Page not found' }, 404);

    const rows = await db
      .selectFrom('zvd_page_views as pv')
      .innerJoin('zvd_views as v', 'v.id', 'pv.view_id')
      .selectAll('pv')
      .select([
        'v.name', 'v.collection', 'v.view_type', 'v.fields',
        'v.filters', 'v.sort_field', 'v.sort_dir', 'v.page_size', 'v.config',
      ])
      .where('pv.page_id', '=', page.id)
      .orderBy('pv.sort_order asc')
      .execute();

    return c.json({ views: rows });
  });

  /** POST /api/zones/:slug/pages/:pageSlug/views */
  app.post('/:slug/pages/:pageSlug/views', zValidator('json', PageViewAddSchema), async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const page = await db
      .selectFrom('zvd_pages as p')
      .innerJoin('zvd_zones as z', 'z.id', 'p.zone_id')
      .select('p.id')
      .where('z.slug', '=', c.req.param('slug'))
      .where('p.slug', '=', c.req.param('pageSlug'))
      .executeTakeFirst();

    if (!page) return c.json({ error: 'Page not found' }, 404);

    const data = c.req.valid('json');

    const pv = await db
      .insertInto('zvd_page_views')
      .values({
        page_id:         page.id,
        view_id:         data.view_id,
        title_override:  data.title_override ?? null,
        col_span:        data.col_span ?? 12,
        sort_order:      data.sort_order ?? 0,
        config_override: JSON.stringify(data.config_override ?? {}),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return c.json({ page_view: pv }, 201);
  });

  /** DELETE /api/zones/:slug/pages/:pageSlug/views/:viewId */
  app.delete('/:slug/pages/:pageSlug/views/:viewId', async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const page = await db
      .selectFrom('zvd_pages as p')
      .innerJoin('zvd_zones as z', 'z.id', 'p.zone_id')
      .select('p.id')
      .where('z.slug', '=', c.req.param('slug'))
      .where('p.slug', '=', c.req.param('pageSlug'))
      .executeTakeFirst();

    if (!page) return c.json({ error: 'Page not found' }, 404);

    await db
      .deleteFrom('zvd_page_views')
      .where('page_id', '=', page.id)
      .where('view_id', '=', c.req.param('viewId'))
      .execute();

    return c.json({ success: true });
  });

  /** PUT /api/zones/:slug/pages/:pageSlug/views/reorder */
  app.put('/:slug/pages/:pageSlug/views/reorder', zValidator('json', ReorderSchema), async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const { ids } = c.req.valid('json');

    await Promise.all(
      ids.map((id, index) =>
        db
          .updateTable('zvd_page_views')
          .set({ sort_order: index })
          .where('id', '=', id)
          .execute(),
      ),
    );

    return c.json({ success: true });
  });

  // ── Public Render API ─────────────────────────────────────────────────────

  /** GET /api/zones/:slug/render — navigation + zone theme */
  app.get('/:slug/render', async (c) => {
    const zone = await db
      .selectFrom('zvd_zones')
      .selectAll()
      .where('slug', '=', c.req.param('slug'))
      .where('is_active', '=', true)
      .executeTakeFirst();

    if (!zone) return c.json({ error: 'Zone not found' }, 404);

    // Check zone access roles
    const user = c.get('user');
    if (zone.access_roles.length > 0) {
      if (!user) return c.json({ error: 'Authentication required' }, 401);
      if (user.role !== 'god' && !zone.access_roles.includes(user.role)) {
        zoneAccessDenied.inc({ zone_slug: zone.slug, role: user.role ?? 'unknown' });
        return c.json({ error: 'Insufficient role' }, 403);
      }
    }

    zoneRenderRequests.inc({ zone_slug: zone.slug, page_slug: '_nav' });

    const pages = await db
      .selectFrom('zvd_pages')
      .selectAll()
      .where('zone_id', '=', zone.id)
      .where('is_active', '=', true)
      .orderBy('sort_order asc')
      .execute();

    // Build nav tree (parent → children)
    const roots = pages.filter((p) => !p.parent_id);
    const nav = roots.map((p) => ({
      ...p,
      children: pages.filter((c) => c.parent_id === p.id),
    }));

    return c.json({ zone, nav });
  });

  /** GET /api/zones/:slug/render/:pageSlug — page + views with resolved data */
  app.get('/:slug/render/:pageSlug', async (c) => {
    const zone = await db
      .selectFrom('zvd_zones')
      .selectAll()
      .where('slug', '=', c.req.param('slug'))
      .where('is_active', '=', true)
      .executeTakeFirst();

    if (!zone) return c.json({ error: 'Zone not found' }, 404);

    // Check zone-level access
    const user = c.get('user');
    if (zone.access_roles.length > 0) {
      if (!user) return c.json({ error: 'Authentication required' }, 401);
      if (user.role !== 'god' && !zone.access_roles.includes(user.role)) {
        zoneAccessDenied.inc({ zone_slug: zone.slug, role: user.role ?? 'unknown' });
        return c.json({ error: 'Insufficient role' }, 403);
      }
    }

    const page = await db
      .selectFrom('zvd_pages')
      .selectAll()
      .where('zone_id', '=', zone.id)
      .where('slug', '=', c.req.param('pageSlug'))
      .where('is_active', '=', true)
      .executeTakeFirst();

    if (!page) return c.json({ error: 'Page not found' }, 404);

    // Check page-level auth
    if (page.auth_required) {
      if (!user) return c.json({ error: 'Authentication required' }, 401);
      const roles = page.allowed_roles as string[];
      if (roles.length > 0 && user.role !== 'god' && !roles.includes(user.role)) {
        zoneAccessDenied.inc({ zone_slug: zone.slug, role: user.role ?? 'unknown' });
        return c.json({ error: 'Insufficient role' }, 403);
      }
    }

    zoneRenderRequests.inc({ zone_slug: zone.slug, page_slug: page.slug });

    // Fetch views with definitions
    const _viewQueryStart = Date.now();
    const viewRows = await db
      .selectFrom('zvd_page_views as pv')
      .innerJoin('zvd_views as v', 'v.id', 'pv.view_id')
      .selectAll('pv')
      .select([
        'v.name', 'v.collection', 'v.view_type', 'v.fields',
        'v.filters', 'v.sort_field', 'v.sort_dir', 'v.page_size', 'v.config',
      ])
      .where('pv.page_id', '=', page.id)
      .orderBy('pv.sort_order asc')
      .execute();

    // Track view query duration per view
    const viewQueryMs = Date.now() - _viewQueryStart;
    for (const vr of viewRows) {
      viewQueryDuration.observe({ view_id: vr.view_id, collection: vr.collection }, viewQueryMs / viewRows.length);
    }

    // Return view definitions + data resolution hint
    // (actual data fetched client-side via /api/data/:collection for flexibility)
    return c.json({
      zone: { id: zone.id, name: zone.name, slug: zone.slug, primary_color: zone.primary_color, nav_position: zone.nav_position },
      page,
      views: viewRows,
    });
  });

  return app;
}

// ── Views routes (standalone /api/views) ─────────────────────────────────────

export function viewsRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // Auth middleware
  app.use('*', async (c, next) => {
    try {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (session?.user) {
        const row = await (db as any)
          .selectFrom('user')
          .select(['role'])
          .where('id', '=', session.user.id)
          .executeTakeFirst();
        c.set('user', { ...session.user, role: row?.role ?? (session.user as any).role });
      }
    } catch {
      // no-op
    }
    await next();
  });

  /** GET /api/views */
  app.get('/', async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const collection = c.req.query('collection');
    const page = Number(c.req.query('page') ?? 1);
    const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);
    const offset = (page - 1) * limit;

    let query = db.selectFrom('zvd_views').selectAll();
    if (collection) query = query.where('collection', '=', collection);

    const [views, countRow] = await Promise.all([
      query.orderBy('name asc').limit(limit).offset(offset).execute(),
      db.selectFrom('zvd_views')
        .select((eb) => eb.fn.countAll().as('total'))
        .executeTakeFirst(),
    ]);

    return c.json({ views, total: Number(countRow?.total ?? 0), page, limit });
  });

  /** POST /api/views */
  app.post('/', zValidator('json', ViewCreateSchema), async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const data = c.req.valid('json');
    const user = c.get('user');

    const view = await db
      .insertInto('zvd_views')
      .values({
        name:        data.name,
        description: data.description ?? null,
        collection:  data.collection,
        view_type:   data.view_type,
        fields:      JSON.stringify(data.fields ?? []),
        filters:     JSON.stringify(data.filters ?? []),
        sort_field:  data.sort_field ?? null,
        sort_dir:    data.sort_dir ?? 'desc',
        page_size:   data.page_size ?? 20,
        config:      JSON.stringify(data.config ?? {}),
        is_public:   data.is_public ?? false,
        created_by:  user?.id ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return c.json({ view }, 201);
  });

  /** GET /api/views/:id */
  app.get('/:id', async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const view = await db
      .selectFrom('zvd_views')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!view) return c.json({ error: 'View not found' }, 404);
    return c.json({ view });
  });

  /** PUT /api/views/:id */
  app.put('/:id', zValidator('json', ViewUpdateSchema), async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const data = c.req.valid('json');
    const update: Record<string, unknown> = { ...data, updated_at: new Date() };
    if (data.fields !== undefined) update.fields = JSON.stringify(data.fields);
    if (data.filters !== undefined) update.filters = JSON.stringify(data.filters);
    if (data.config !== undefined) update.config = JSON.stringify(data.config);

    const view = await db
      .updateTable('zvd_views')
      .set(update)
      .where('id', '=', c.req.param('id'))
      .returningAll()
      .executeTakeFirst();

    if (!view) return c.json({ error: 'View not found' }, 404);
    return c.json({ view });
  });

  /** DELETE /api/views/:id */
  app.delete('/:id', async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    await db
      .deleteFrom('zvd_views')
      .where('id', '=', c.req.param('id'))
      .execute();

    return c.json({ success: true });
  });

  return app;
}
