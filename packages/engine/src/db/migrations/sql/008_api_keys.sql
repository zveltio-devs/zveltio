-- Migration 008: API Keys for external access

CREATE TABLE IF NOT EXISTS zv_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,  -- SHA-256, never stored in plain
  key_prefix TEXT NOT NULL,       -- First 12 chars for identification (e.g. "zvk_a1b2c3")
  scopes JSONB NOT NULL DEFAULT '[]',
  -- scopes: [{"collection": "products", "actions": ["read"]}, {"collection": "*", "actions": ["read"]}]
  rate_limit INTEGER NOT NULL DEFAULT 1000,  -- requests per hour
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON zv_api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON zv_api_keys(created_by);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON zv_api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON zv_api_keys(is_active) WHERE is_active = true;

-- DOWN
DROP INDEX IF EXISTS idx_api_keys_active;
DROP INDEX IF EXISTS idx_api_keys_prefix;
DROP INDEX IF EXISTS idx_api_keys_user;
DROP INDEX IF EXISTS idx_api_keys_hash;
DROP TABLE IF EXISTS zv_api_keys;
