-- Migration: 018_media
-- Extends media library (created in 005_storage) with tags, extra metadata columns

-- Add columns missing from the initial 005 schema
ALTER TABLE zv_media_files ADD COLUMN IF NOT EXISTS title          TEXT;
ALTER TABLE zv_media_files ADD COLUMN IF NOT EXISTS description    TEXT;
ALTER TABLE zv_media_files ADD COLUMN IF NOT EXISTS alt_text       TEXT;
ALTER TABLE zv_media_files ADD COLUMN IF NOT EXISTS thumbnail_url  TEXT;
ALTER TABLE zv_media_files ADD COLUMN IF NOT EXISTS duration_seconds INT;

-- Tags vocabulary
CREATE TABLE IF NOT EXISTS zv_media_tags (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL UNIQUE,
  color      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- File ↔ tag join table (file_id must be UUID to match zv_media_files.id)
CREATE TABLE IF NOT EXISTS zv_media_file_tags (
  file_id UUID NOT NULL REFERENCES zv_media_files(id) ON DELETE CASCADE,
  tag_id  UUID NOT NULL REFERENCES zv_media_tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (file_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_zv_media_file_tags_file ON zv_media_file_tags(file_id);
CREATE INDEX IF NOT EXISTS idx_zv_media_file_tags_tag  ON zv_media_file_tags(tag_id);

-- DOWN
DROP INDEX IF EXISTS idx_zv_media_file_tags_tag;
DROP INDEX IF EXISTS idx_zv_media_file_tags_file;
DROP TABLE IF EXISTS zv_media_file_tags;
DROP TABLE IF EXISTS zv_media_tags;
ALTER TABLE zv_media_files DROP COLUMN IF EXISTS duration_seconds;
ALTER TABLE zv_media_files DROP COLUMN IF EXISTS thumbnail_url;
ALTER TABLE zv_media_files DROP COLUMN IF EXISTS alt_text;
ALTER TABLE zv_media_files DROP COLUMN IF EXISTS description;
ALTER TABLE zv_media_files DROP COLUMN IF EXISTS title;
