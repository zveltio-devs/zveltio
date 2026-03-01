-- Migration: 018_media
-- Media library: folders, files, tags

CREATE TABLE IF NOT EXISTS zv_media_folders (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  parent_id   TEXT REFERENCES zv_media_folders(id) ON DELETE CASCADE,
  description TEXT,
  created_by  TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zv_media_files (
  id                TEXT PRIMARY KEY,
  folder_id         TEXT REFERENCES zv_media_folders(id) ON DELETE SET NULL,
  filename          TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  mime_type         TEXT NOT NULL,
  size_bytes        BIGINT NOT NULL,
  width             INT,
  height            INT,
  duration_seconds  INT,
  url               TEXT NOT NULL,
  thumbnail_url     TEXT,
  storage_path      TEXT NOT NULL,
  uploaded_by       TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  title             TEXT,
  description       TEXT,
  alt_text          TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zv_media_tags (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  color      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zv_media_file_tags (
  file_id TEXT NOT NULL REFERENCES zv_media_files(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES zv_media_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (file_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_zv_media_folders_parent     ON zv_media_folders(parent_id);
CREATE INDEX IF NOT EXISTS idx_zv_media_files_folder       ON zv_media_files(folder_id);
CREATE INDEX IF NOT EXISTS idx_zv_media_files_mime         ON zv_media_files(mime_type);
CREATE INDEX IF NOT EXISTS idx_zv_media_files_created      ON zv_media_files(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_zv_media_file_tags_file     ON zv_media_file_tags(file_id);
CREATE INDEX IF NOT EXISTS idx_zv_media_file_tags_tag      ON zv_media_file_tags(tag_id);
