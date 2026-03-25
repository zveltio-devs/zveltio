-- Migration: 056_portal_extras
-- Add nav_position, footer, SEO fields to portal theme.
-- Also add layout + description to portal pages, is_visible + collection_view_id to sections.

ALTER TABLE public.zvd_portal_theme
  ADD COLUMN IF NOT EXISTS nav_position    TEXT NOT NULL DEFAULT 'top'
    CHECK (nav_position IN ('top', 'sidebar', 'none')),
  ADD COLUMN IF NOT EXISTS footer_text     TEXT,
  ADD COLUMN IF NOT EXISTS meta_title      TEXT,
  ADD COLUMN IF NOT EXISTS meta_description TEXT;

ALTER TABLE public.zvd_portal_pages
  ADD COLUMN IF NOT EXISTS description     TEXT,
  ADD COLUMN IF NOT EXISTS layout          TEXT NOT NULL DEFAULT 'default';

ALTER TABLE public.zvd_portal_sections
  ADD COLUMN IF NOT EXISTS is_visible          BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS collection_view_id  UUID REFERENCES public.zvd_collection_views(id) ON DELETE SET NULL;
