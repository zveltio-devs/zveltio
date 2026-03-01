-- Migration: 020_pages
-- CMS Pages, page sections, and form submissions

CREATE TABLE IF NOT EXISTS zv_pages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title            TEXT NOT NULL,
  slug             TEXT NOT NULL UNIQUE,
  description      TEXT,
  meta_title       TEXT,
  meta_description TEXT,
  og_image         TEXT,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  is_homepage      BOOLEAN NOT NULL DEFAULT false,
  layout           TEXT NOT NULL DEFAULT 'default'
                     CHECK (layout IN ('default', 'full-width', 'sidebar-left', 'sidebar-right')),
  created_by       TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_zv_pages_slug     ON zv_pages(slug);
CREATE UNIQUE INDEX IF NOT EXISTS idx_zv_pages_homepage ON zv_pages(is_homepage) WHERE is_homepage = true;
CREATE INDEX IF NOT EXISTS idx_zv_pages_active          ON zv_pages(is_active);

CREATE TABLE IF NOT EXISTS zv_page_sections (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id        UUID NOT NULL REFERENCES zv_pages(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL
                   CHECK (type IN ('hero', 'grid', 'list', 'carousel', 'text', 'html', 'map', 'form', 'stats', 'banner', 'cta', 'divider')),
  sort_order     INTEGER NOT NULL DEFAULT 0,
  is_visible     BOOLEAN NOT NULL DEFAULT true,
  collection     TEXT,
  filter_config  JSONB NOT NULL DEFAULT '{}',
  sort_config    JSONB NOT NULL DEFAULT '[]',
  limit_count    INTEGER NOT NULL DEFAULT 10,
  fields         TEXT[] NOT NULL DEFAULT '{}',
  slug_field     TEXT,
  static_content JSONB NOT NULL DEFAULT '{}',
  style_config   JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_page_sections_page ON zv_page_sections(page_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_zv_page_sections_type ON zv_page_sections(type);

CREATE TABLE IF NOT EXISTS zv_form_submissions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id         UUID NOT NULL REFERENCES zv_pages(id) ON DELETE CASCADE,
  section_id      UUID NOT NULL REFERENCES zv_page_sections(id) ON DELETE CASCADE,
  data            JSONB NOT NULL DEFAULT '{}',
  submitter_ip    TEXT,
  submitter_email TEXT,
  status          TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'read', 'replied', 'spam')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_form_submissions_page    ON zv_form_submissions(page_id);
CREATE INDEX IF NOT EXISTS idx_zv_form_submissions_section ON zv_form_submissions(section_id);
CREATE INDEX IF NOT EXISTS idx_zv_form_submissions_status  ON zv_form_submissions(status);
