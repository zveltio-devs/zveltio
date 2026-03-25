-- Migration: 055_portal
-- Portal Views system: theme, pages, sections, collection views
-- All tables support multi-tenancy via tenant_id (NULL = default/single-tenant install)

-- ── Portal Theme ─────────────────────────────────────────────────────────────
-- One row per tenant (or NULL for single-tenant). Stores branding + colors + typography.
CREATE TABLE IF NOT EXISTS public.zvd_portal_theme (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID        REFERENCES public.zv_tenants(id) ON DELETE CASCADE,

  -- Branding
  app_name          TEXT        NOT NULL DEFAULT 'My App',
  logo_url          TEXT,
  favicon_url       TEXT,

  -- Colors (hex, converted to CSS vars at render time)
  color_primary     TEXT        NOT NULL DEFAULT '#570df8',
  color_secondary   TEXT        NOT NULL DEFAULT '#f000b8',
  color_accent      TEXT        NOT NULL DEFAULT '#37cdbe',
  color_neutral     TEXT        NOT NULL DEFAULT '#3d4451',
  color_base_100    TEXT        NOT NULL DEFAULT '#ffffff',
  color_base_200    TEXT        NOT NULL DEFAULT '#f2f2f2',
  color_base_300    TEXT        NOT NULL DEFAULT '#e5e6e6',

  -- Typography
  font_family       TEXT        NOT NULL DEFAULT 'Inter, system-ui, sans-serif',
  font_size_base    TEXT        NOT NULL DEFAULT '16px',

  -- Shape
  border_radius     TEXT        NOT NULL DEFAULT '0.5rem'
                                CHECK (border_radius IN ('0px', '0.25rem', '0.5rem', '1rem', '9999px')),

  -- Dark mode: 'light' | 'dark' | 'auto'
  color_scheme      TEXT        NOT NULL DEFAULT 'auto'
                                CHECK (color_scheme IN ('light', 'dark', 'auto')),

  -- Custom CSS injected in portal <head> (power users)
  custom_css        TEXT,

  -- Meta
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id)  -- one theme per tenant (NULLS are not equal → only one NULL allowed via partial index)
);

-- Enforce single default theme (tenant_id IS NULL)
CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_theme_default
  ON public.zvd_portal_theme ((tenant_id IS NULL))
  WHERE tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_portal_theme_tenant
  ON public.zvd_portal_theme (tenant_id);

-- ── Portal Pages ──────────────────────────────────────────────────────────────
-- Top-level navigation pages visible in the portal.
CREATE TABLE IF NOT EXISTS public.zvd_portal_pages (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        REFERENCES public.zv_tenants(id) ON DELETE CASCADE,

  slug            TEXT        NOT NULL,
  title           TEXT        NOT NULL,
  icon            TEXT,                           -- lucide icon name

  -- Access control
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  is_homepage     BOOLEAN     NOT NULL DEFAULT false,
  auth_required   BOOLEAN     NOT NULL DEFAULT false,
  allowed_roles   TEXT[]      NOT NULL DEFAULT '{}',  -- empty = all roles allowed

  -- Navigation
  parent_id       UUID        REFERENCES public.zvd_portal_pages(id) ON DELETE SET NULL,
  sort_order      INTEGER     NOT NULL DEFAULT 0,

  -- Meta
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_portal_pages_tenant
  ON public.zvd_portal_pages (tenant_id, is_active, sort_order);
CREATE INDEX IF NOT EXISTS idx_portal_pages_homepage
  ON public.zvd_portal_pages (tenant_id, is_homepage) WHERE is_homepage = true;

-- ── Portal Sections ───────────────────────────────────────────────────────────
-- Sections (blocks) within a portal page. Each section has a view_type and config.
CREATE TABLE IF NOT EXISTS public.zvd_portal_sections (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        REFERENCES public.zv_tenants(id) ON DELETE CASCADE,
  page_id         UUID        NOT NULL REFERENCES public.zvd_portal_pages(id) ON DELETE CASCADE,

  -- View type: table | detail | form | kanban | calendar | gallery | stats | chart | rich-text | map
  view_type       TEXT        NOT NULL
                              CHECK (view_type IN (
                                'table', 'detail', 'form', 'kanban', 'calendar',
                                'gallery', 'stats', 'chart', 'rich-text', 'map', 'custom'
                              )),

  title           TEXT,
  -- Which collection this section displays (NULL for rich-text / custom)
  collection      TEXT,

  -- View-type-specific configuration (columns, filters, groupBy, etc.)
  config          JSONB       NOT NULL DEFAULT '{}',

  -- Layout
  sort_order      INTEGER     NOT NULL DEFAULT 0,
  -- Column span in a 12-col grid (full-width = 12, half = 6, third = 4)
  col_span        INTEGER     NOT NULL DEFAULT 12
                              CHECK (col_span BETWEEN 1 AND 12),

  -- Meta
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_portal_sections_page
  ON public.zvd_portal_sections (page_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_portal_sections_tenant
  ON public.zvd_portal_sections (tenant_id);

-- ── Collection Views (Studio) ─────────────────────────────────────────────────
-- Saved view configurations per collection, displayed in Studio's collection detail.
CREATE TABLE IF NOT EXISTS public.zvd_collection_views (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        REFERENCES public.zv_tenants(id) ON DELETE CASCADE,

  collection      TEXT        NOT NULL,
  name            TEXT        NOT NULL,

  view_type       TEXT        NOT NULL
                              CHECK (view_type IN (
                                'table', 'kanban', 'calendar', 'gallery', 'stats', 'chart', 'map'
                              )),

  config          JSONB       NOT NULL DEFAULT '{}',

  is_default      BOOLEAN     NOT NULL DEFAULT false,
  created_by      TEXT        REFERENCES public."user"(id) ON DELETE SET NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_collection_views_collection
  ON public.zvd_collection_views (tenant_id, collection);
-- Only one default view per (tenant, collection)
CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_views_default
  ON public.zvd_collection_views (tenant_id, collection)
  WHERE is_default = true;
-- For NULL tenant_id (single-tenant)
CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_views_default_null_tenant
  ON public.zvd_collection_views (collection)
  WHERE is_default = true AND tenant_id IS NULL;

-- ── Seed default theme ────────────────────────────────────────────────────────
-- Insert a default theme for single-tenant installs (tenant_id IS NULL)
INSERT INTO public.zvd_portal_theme (app_name) VALUES ('My App')
  ON CONFLICT DO NOTHING;

-- DOWN
-- DROP INDEX IF EXISTS idx_collection_views_default_null_tenant;
-- DROP INDEX IF EXISTS idx_collection_views_default;
-- DROP INDEX IF EXISTS idx_collection_views_collection;
-- DROP TABLE IF EXISTS public.zvd_collection_views;
-- DROP INDEX IF EXISTS idx_portal_sections_tenant;
-- DROP INDEX IF EXISTS idx_portal_sections_page;
-- DROP TABLE IF EXISTS public.zvd_portal_sections;
-- DROP INDEX IF EXISTS idx_portal_pages_homepage;
-- DROP INDEX IF EXISTS idx_portal_pages_tenant;
-- DROP TABLE IF EXISTS public.zvd_portal_pages;
-- DROP INDEX IF EXISTS idx_portal_theme_tenant;
-- DROP INDEX IF EXISTS idx_portal_theme_default;
-- DROP TABLE IF EXISTS public.zvd_portal_theme;
