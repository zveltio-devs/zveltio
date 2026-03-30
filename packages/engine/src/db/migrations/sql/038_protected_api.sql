-- 041_protected_api.sql
-- Enhanced API keys with IP whitelisting and Casbin integration

ALTER TABLE zv_api_keys ADD COLUMN IF NOT EXISTS allowed_ips TEXT[] DEFAULT NULL;
ALTER TABLE zv_api_keys ADD COLUMN IF NOT EXISTS organization TEXT DEFAULT NULL;
ALTER TABLE zv_api_keys ADD COLUMN IF NOT EXISTS description TEXT DEFAULT NULL;
ALTER TABLE zv_api_keys ADD COLUMN IF NOT EXISTS permissions_mode TEXT NOT NULL DEFAULT 'scoped'
  CHECK (permissions_mode IN ('scoped', 'casbin', 'god'));
ALTER TABLE zv_api_keys ADD COLUMN IF NOT EXISTS casbin_subject TEXT DEFAULT NULL;
ALTER TABLE zv_api_keys ADD COLUMN IF NOT EXISTS request_count BIGINT NOT NULL DEFAULT 0;
ALTER TABLE zv_api_keys ADD COLUMN IF NOT EXISTS last_ip TEXT DEFAULT NULL;

CREATE TABLE IF NOT EXISTS zv_api_key_access_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id  UUID        NOT NULL REFERENCES zv_api_keys(id) ON DELETE CASCADE,
  ip_address  TEXT        NOT NULL,
  method      TEXT        NOT NULL,
  path        TEXT        NOT NULL,
  status_code INT,
  duration_ms INT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_key_access_log_key ON zv_api_key_access_log(api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_key_access_log_created ON zv_api_key_access_log(created_at DESC);

-- DOWN
DROP INDEX IF EXISTS idx_api_key_access_log_created;
DROP INDEX IF EXISTS idx_api_key_access_log_key;
DROP TABLE IF EXISTS zv_api_key_access_log;
ALTER TABLE zv_api_keys DROP COLUMN IF EXISTS last_ip;
ALTER TABLE zv_api_keys DROP COLUMN IF EXISTS request_count;
ALTER TABLE zv_api_keys DROP COLUMN IF EXISTS casbin_subject;
ALTER TABLE zv_api_keys DROP COLUMN IF EXISTS permissions_mode;
ALTER TABLE zv_api_keys DROP COLUMN IF EXISTS description;
ALTER TABLE zv_api_keys DROP COLUMN IF EXISTS organization;
ALTER TABLE zv_api_keys DROP COLUMN IF EXISTS allowed_ips;
