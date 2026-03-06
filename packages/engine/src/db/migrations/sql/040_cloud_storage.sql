-- 040_cloud_storage.sql
-- Zveltio Cloud: versioning, trash, sharing, favorites, quotas

-- === FILE VERSIONS ===
-- Each new upload to an existing file creates a version
CREATE TABLE IF NOT EXISTS zv_media_versions (
  id            TEXT        PRIMARY KEY,
  file_id       TEXT        NOT NULL REFERENCES zv_media_files(id) ON DELETE CASCADE,
  version_num   INT         NOT NULL DEFAULT 1,
  storage_path  TEXT        NOT NULL,
  size_bytes    BIGINT      NOT NULL,
  mime_type     TEXT        NOT NULL,
  checksum      TEXT,
  uploaded_by   TEXT        REFERENCES "user"(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(file_id, version_num)
);

CREATE INDEX IF NOT EXISTS idx_media_versions_file ON zv_media_versions(file_id, version_num DESC);

-- === TRASH BIN ===
-- Soft delete: files go to trash, permanently deleted after 30 days
ALTER TABLE zv_media_files ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE zv_media_files ADD COLUMN IF NOT EXISTS deleted_by TEXT REFERENCES "user"(id) ON DELETE SET NULL;
ALTER TABLE zv_media_files ADD COLUMN IF NOT EXISTS restore_folder_id TEXT;

CREATE INDEX IF NOT EXISTS idx_media_files_deleted ON zv_media_files(deleted_at) WHERE deleted_at IS NOT NULL;

-- Soft delete on folders
ALTER TABLE zv_media_folders ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

-- === PUBLIC SHARING ===
CREATE TABLE IF NOT EXISTS zv_media_shares (
  id            TEXT        PRIMARY KEY,
  file_id       TEXT        REFERENCES zv_media_files(id) ON DELETE CASCADE,
  folder_id     TEXT        REFERENCES zv_media_folders(id) ON DELETE CASCADE,
  token         TEXT        NOT NULL UNIQUE,
  share_type    TEXT        NOT NULL DEFAULT 'view' CHECK (share_type IN ('view', 'download', 'edit')),
  password_hash TEXT,
  expires_at    TIMESTAMPTZ,
  max_downloads INT,
  download_count INT        NOT NULL DEFAULT 0,
  created_by    TEXT        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (file_id IS NOT NULL OR folder_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_media_shares_token ON zv_media_shares(token) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_media_shares_file ON zv_media_shares(file_id);
CREATE INDEX IF NOT EXISTS idx_media_shares_folder ON zv_media_shares(folder_id);

-- === FAVORITES ===
CREATE TABLE IF NOT EXISTS zv_media_favorites (
  user_id     TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  file_id     TEXT NOT NULL REFERENCES zv_media_files(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, file_id)
);

-- === STORAGE QUOTAS ===
CREATE TABLE IF NOT EXISTS zv_storage_quotas (
  user_id       TEXT        PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  quota_bytes   BIGINT      NOT NULL DEFAULT 5368709120,
  used_bytes    BIGINT      NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
