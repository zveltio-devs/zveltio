-- Migration 003: AI Long-term Memory
-- Tabel pentru memoria persistentă a agentului AI per utilizator

-- Activează extensia pgvector (necesară pentru coloana vector(1536))
-- Dacă extensia nu este disponibilă, coloana embedding va fi omisă manual
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS zv_ai_memory (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  context_key TEXT NOT NULL,
  content     TEXT NOT NULL,
  -- Embedding pentru căutare semantică (dimensiune OpenAI text-embedding-3-small)
  -- NULL când embeddings nu sunt configurate (fallback la ILIKE)
  embedding   vector(1536),
  importance  SMALLINT NOT NULL DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  source      TEXT DEFAULT 'user',  -- 'user' | 'agent' | 'background'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, context_key)  -- Același key = upsert, nu duplicate
);

-- Index pentru căutare rapidă per user
CREATE INDEX IF NOT EXISTS idx_zv_ai_memory_user
  ON zv_ai_memory(user_id, updated_at DESC);

-- Index GIN pentru fulltext fallback (fără embeddings)
CREATE INDEX IF NOT EXISTS idx_zv_ai_memory_content_gin
  ON zv_ai_memory USING gin(to_tsvector('english', content));

-- Index IVFFlat pentru căutare vectorială semantică (activ doar dacă pgvector disponibil)
-- Se creează condițional pentru că necesită date existente
-- Rulează manual după populare:
-- CREATE INDEX idx_zv_ai_memory_embedding ON zv_ai_memory
--   USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Trigger pentru updated_at automat
CREATE OR REPLACE FUNCTION update_zv_ai_memory_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_zv_ai_memory_updated_at
  BEFORE UPDATE ON zv_ai_memory
  FOR EACH ROW EXECUTE FUNCTION update_zv_ai_memory_updated_at();
