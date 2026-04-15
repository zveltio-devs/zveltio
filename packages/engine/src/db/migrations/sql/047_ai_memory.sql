-- Migration 052: AI Memory — per-user key-value context store for ZveltioAI

CREATE TABLE IF NOT EXISTS zv_ai_memory (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  context_key  TEXT        NOT NULL,
  content      TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, context_key)
);

CREATE INDEX IF NOT EXISTS idx_zv_ai_memory_user ON zv_ai_memory(user_id);

-- DOWN
DROP INDEX IF EXISTS idx_zv_ai_memory_user;
DROP TABLE IF EXISTS zv_ai_memory;
