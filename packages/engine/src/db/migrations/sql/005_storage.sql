-- Migration 005: File storage (media library)

CREATE TABLE IF NOT EXISTS zv_media_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  parent_id UUID REFERENCES zv_media_folders(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_media_folders_parent ON zv_media_folders(parent_id);

CREATE TABLE IF NOT EXISTS zv_media_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id UUID REFERENCES zv_media_folders(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mimetype TEXT NOT NULL,
  size BIGINT NOT NULL DEFAULT 0,
  storage_path TEXT NOT NULL,  -- S3/SeaweedFS path
  url TEXT,                     -- Public URL if applicable
  width INTEGER,                -- For images
  height INTEGER,               -- For images
  metadata JSONB DEFAULT '{}',
  created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_media_files_folder ON zv_media_files(folder_id);
CREATE INDEX IF NOT EXISTS idx_zv_media_files_mimetype ON zv_media_files(mimetype);
CREATE INDEX IF NOT EXISTS idx_zv_media_files_created ON zv_media_files(created_at DESC);

-- DOWN
DROP INDEX IF EXISTS idx_zv_media_files_created;
DROP INDEX IF EXISTS idx_zv_media_files_mimetype;
DROP INDEX IF EXISTS idx_zv_media_files_folder;
DROP TABLE IF EXISTS zv_media_files;
DROP INDEX IF EXISTS idx_zv_media_folders_parent;
DROP TABLE IF EXISTS zv_media_folders;
