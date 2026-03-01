-- Migration: 022_drafts
-- Content drafts and publish scheduling

CREATE TABLE IF NOT EXISTS zv_content_drafts (
  id           UUID   PRIMARY KEY DEFAULT gen_random_uuid(),
  collection   TEXT   NOT NULL,
  record_id    TEXT   NOT NULL,
  draft_data   JSONB  NOT NULL DEFAULT '{}',
  base_version INT    NOT NULL DEFAULT 1,
  status       TEXT   NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','review','approved','rejected')),
  notes        TEXT,
  scheduled_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  created_by   TEXT   REFERENCES "user"(id) ON DELETE SET NULL,
  reviewed_by  TEXT   REFERENCES "user"(id) ON DELETE SET NULL,
  reviewed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zv_collection_publish_settings (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  collection      TEXT    NOT NULL UNIQUE,
  drafts_enabled  BOOLEAN NOT NULL DEFAULT false,
  require_review  BOOLEAN NOT NULL DEFAULT false,
  reviewer_roles  JSONB   NOT NULL DEFAULT '["admin"]',
  auto_publish    BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zv_publish_schedule (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id     UUID NOT NULL REFERENCES zv_content_drafts(id) ON DELETE CASCADE,
  scheduled_at TIMESTAMPTZ NOT NULL,
  processed    BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_drafts_collection ON zv_content_drafts(collection, record_id);
CREATE INDEX IF NOT EXISTS idx_drafts_status     ON zv_content_drafts(status);
CREATE INDEX IF NOT EXISTS idx_drafts_created_by ON zv_content_drafts(created_by);
CREATE INDEX IF NOT EXISTS idx_publish_schedule  ON zv_publish_schedule(scheduled_at) WHERE NOT processed;
