-- Admin-configurable rate limit overrides per tier and per API key
CREATE TABLE IF NOT EXISTS zv_rate_limit_configs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_prefix  TEXT NOT NULL UNIQUE,  -- 'api', 'auth', 'ai', 'write', 'ddl', 'destructive', or 'apikey:<uuid>'
  window_ms   INTEGER NOT NULL DEFAULT 60000,
  max_requests INTEGER NOT NULL DEFAULT 200,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  description TEXT,
  updated_by  UUID,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed defaults so the UI always shows values even before any admin changes
INSERT INTO zv_rate_limit_configs (key_prefix, window_ms, max_requests, description) VALUES
  ('auth',        60000,  10,  'Authentication endpoints (sign-in, sign-up, forgot-password)'),
  ('api',         60000,  200, 'General API endpoints'),
  ('ai',          60000,  20,  'AI features (chat, search, embeddings)'),
  ('write',       60000,  60,  'Write operations (POST/PUT/PATCH/DELETE on data)'),
  ('ddl',         60000,  10,  'Schema changes (DDL operations)'),
  ('destructive', 60000,  10,  'Destructive operations (DELETE rows and collections)')
ON CONFLICT (key_prefix) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_rate_limit_configs_active ON zv_rate_limit_configs(key_prefix) WHERE is_active = true;

-- DOWN
DROP INDEX IF EXISTS idx_rate_limit_configs_active;
DROP TABLE IF EXISTS zv_rate_limit_configs;
