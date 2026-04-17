-- Migration 060: Zones / Pages / Views — unified portal architecture
-- Replaces: zvd_portal_pages, zvd_portal_sections, zvd_portal_theme,
--           zvd_collection_views, zvd_portal_client_config
-- ═══════════════════════════════════════════════════════════════════

-- LAYER 1: Views — atomic reusable blocks
CREATE TABLE IF NOT EXISTS zvd_views (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID        REFERENCES zv_tenants(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  description  TEXT,
  collection   TEXT        NOT NULL,
  view_type    TEXT        NOT NULL DEFAULT 'table'
                 CHECK (view_type IN ('table','kanban','calendar','gallery','stats','chart','list','timeline')),
  fields       JSONB       NOT NULL DEFAULT '[]',
  filters      JSONB       NOT NULL DEFAULT '[]',
  sort_field   TEXT,
  sort_dir     TEXT        DEFAULT 'desc' CHECK (sort_dir IN ('asc','desc')),
  page_size    INT         DEFAULT 20,
  config       JSONB       NOT NULL DEFAULT '{}',
  is_public    BOOLEAN     NOT NULL DEFAULT false,
  created_by   TEXT        REFERENCES "user"(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zvd_views_collection ON zvd_views(collection);
CREATE INDEX IF NOT EXISTS idx_zvd_views_tenant     ON zvd_views(tenant_id);

-- LAYER 2: Zones — complete portals with own navigation, access rules, branding
CREATE TABLE IF NOT EXISTS zvd_zones (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID        REFERENCES zv_tenants(id) ON DELETE CASCADE,
  name           TEXT        NOT NULL,
  slug           TEXT        NOT NULL,
  description    TEXT,
  is_active      BOOLEAN     NOT NULL DEFAULT false,
  access_roles   TEXT[]      NOT NULL DEFAULT '{}',
  base_path      TEXT        NOT NULL,
  -- Per-zone branding
  site_name      TEXT,
  site_logo_url  TEXT,
  primary_color  TEXT        DEFAULT '#069494',
  secondary_color TEXT,
  custom_css     TEXT,
  nav_position   TEXT        DEFAULT 'sidebar' CHECK (nav_position IN ('sidebar','topbar','both')),
  show_breadcrumbs BOOLEAN   NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_zvd_zones_slug   ON zvd_zones(slug);
CREATE INDEX IF NOT EXISTS idx_zvd_zones_tenant ON zvd_zones(tenant_id);

-- LAYER 3: Pages — view containers, belong to a Zone
CREATE TABLE IF NOT EXISTS zvd_pages (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID        REFERENCES zv_tenants(id) ON DELETE CASCADE,
  zone_id       UUID        NOT NULL REFERENCES zvd_zones(id) ON DELETE CASCADE,
  parent_id     UUID        REFERENCES zvd_pages(id) ON DELETE SET NULL,
  title         TEXT        NOT NULL,
  slug          TEXT        NOT NULL,
  icon          TEXT,
  description   TEXT,
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  is_homepage   BOOLEAN     NOT NULL DEFAULT false,
  auth_required BOOLEAN     NOT NULL DEFAULT true,
  allowed_roles TEXT[]      NOT NULL DEFAULT '{}',
  sort_order    INT         NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (zone_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_zvd_pages_zone   ON zvd_pages(zone_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_zvd_pages_tenant ON zvd_pages(tenant_id);

-- Junction Page ↔ View (M:N — a view can appear on multiple pages)
CREATE TABLE IF NOT EXISTS zvd_page_views (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id         UUID NOT NULL REFERENCES zvd_pages(id) ON DELETE CASCADE,
  view_id         UUID NOT NULL REFERENCES zvd_views(id) ON DELETE CASCADE,
  title_override  TEXT,
  col_span        INT  NOT NULL DEFAULT 12 CHECK (col_span BETWEEN 1 AND 12),
  sort_order      INT  NOT NULL DEFAULT 0,
  config_override JSONB NOT NULL DEFAULT '{}',
  UNIQUE (page_id, view_id)
);

CREATE INDEX IF NOT EXISTS idx_zvd_page_views_page ON zvd_page_views(page_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_zvd_page_views_view ON zvd_page_views(view_id);

-- ═══ SEED DATA ════════════════════════════════════════════════════════════

-- Seed default client zone
INSERT INTO zvd_zones (name, slug, description, is_active, base_path, site_name, primary_color, nav_position)
VALUES ('Client Portal', 'client', 'Portal for external clients', false, '/portal-client', 'Client Portal', '#069494', 'sidebar')
ON CONFLICT DO NOTHING;

-- Create default "intranet" zone
INSERT INTO zvd_zones (name, slug, description, is_active, base_path, access_roles, site_name, nav_position)
VALUES ('Intranet', 'intranet', 'Internal portal for staff', false, '/intranet', ARRAY['employee','manager'], 'Intranet', 'sidebar')
ON CONFLICT DO NOTHING;

-- DOWN
-- DROP TABLE IF EXISTS zvd_page_views;
-- DROP TABLE IF EXISTS zvd_pages;
-- DROP TABLE IF EXISTS zvd_zones;
-- DROP TABLE IF EXISTS zvd_views;
