-- Cloud Storage Extension
-- File versioning, soft-delete trash bin, and public share links

CREATE TABLE IF NOT EXISTS zv_cloud_file_versions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_key    TEXT NOT NULL,          -- SeaweedFS object key
  bucket      TEXT NOT NULL DEFAULT 'zveltio',
  version     INTEGER NOT NULL DEFAULT 1,
  size        BIGINT NOT NULL DEFAULT 0,
  content_type TEXT,
  etag        TEXT,
  created_by  TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(file_key, version)
);

CREATE TABLE IF NOT EXISTS zv_cloud_trash (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_key      TEXT NOT NULL,
  original_path TEXT NOT NULL,
  bucket        TEXT NOT NULL DEFAULT 'zveltio',
  size          BIGINT NOT NULL DEFAULT 0,
  content_type  TEXT,
  deleted_by    TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  deleted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Auto-purge after 30 days
  purge_after   TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '30 days'
);

CREATE TABLE IF NOT EXISTS zv_cloud_shares (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token       TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'base64url'),
  file_key    TEXT NOT NULL,
  bucket      TEXT NOT NULL DEFAULT 'zveltio',
  filename    TEXT,
  content_type TEXT,
  -- Access control
  password_hash TEXT,             -- optional password protection
  max_downloads INTEGER,          -- NULL = unlimited
  download_count INTEGER NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ,        -- NULL = never expires
  -- Metadata
  created_by  TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_versions_key ON zv_cloud_file_versions(file_key);
CREATE INDEX IF NOT EXISTS idx_cloud_trash_purge ON zv_cloud_trash(purge_after);
CREATE INDEX IF NOT EXISTS idx_cloud_shares_token ON zv_cloud_shares(token);
