-- AI provider configurations
CREATE TABLE IF NOT EXISTS zv_ai_providers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL UNIQUE,  -- openai, anthropic, gemini, ollama
  display_name TEXT NOT NULL,
  api_key      TEXT,                  -- encrypted at rest in production
  base_url     TEXT,                  -- for Ollama / custom endpoints
  default_model TEXT,
  is_default   BOOLEAN NOT NULL DEFAULT false,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  config       JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- AI usage log
CREATE TABLE IF NOT EXISTS zv_ai_usage (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     TEXT NOT NULL,
  model        TEXT NOT NULL,
  operation    TEXT NOT NULL,  -- chat, embed, complete
  prompt_tokens   INTEGER NOT NULL DEFAULT 0,
  response_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms   INTEGER,
  user_id      UUID,
  metadata     JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- AI prompt templates
CREATE TABLE IF NOT EXISTS zv_ai_prompts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  system      TEXT,
  template    TEXT NOT NULL,
  variables   JSONB NOT NULL DEFAULT '[]',  -- [{name, description, required}]
  category    TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_provider ON zv_ai_usage(provider, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON zv_ai_usage(user_id, created_at DESC);
