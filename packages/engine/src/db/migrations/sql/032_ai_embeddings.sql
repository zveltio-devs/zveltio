-- 032_ai_embeddings.sql
-- pgvector + embeddings table for AI Search

-- Enable pgvector extension (requires PostgreSQL with pgvector installed)
CREATE EXTENSION IF NOT EXISTS vector;

-- Embeddings table per record per field
CREATE TABLE IF NOT EXISTS zvd_ai_embeddings (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  collection   TEXT        NOT NULL,
  record_id    TEXT        NOT NULL,
  field        TEXT        NOT NULL DEFAULT '_auto',  -- field embedded or '_auto' = all
  text_content TEXT        NOT NULL DEFAULT '',       -- text that generated the embedding
  embedding    vector(1536),                          -- OpenAI text-embedding-3-small dimension
  model        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (collection, record_id, field)
);

CREATE INDEX IF NOT EXISTS idx_zvd_ai_embeddings_lookup
  ON zvd_ai_embeddings (collection, record_id);

-- Cosine similarity index (IVFFlat — requires at least 1 row in table to be useful)
-- Created with lists=100; adjust to rows/1000 in production
CREATE INDEX IF NOT EXISTS idx_zvd_ai_embeddings_ivfflat
  ON zvd_ai_embeddings USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- AI Search columns on zvd_collections
ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS ai_search_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS ai_search_field   TEXT    DEFAULT NULL;

COMMENT ON COLUMN zvd_collections.ai_search_enabled IS 'Enable auto-embedding on create/update';
COMMENT ON COLUMN zvd_collections.ai_search_field   IS 'Field to embed; NULL = concat all text fields';

-- DOWN
ALTER TABLE zvd_collections DROP COLUMN IF EXISTS ai_search_field;
ALTER TABLE zvd_collections DROP COLUMN IF EXISTS ai_search_enabled;
DROP INDEX IF EXISTS idx_zvd_ai_embeddings_ivfflat;
DROP INDEX IF EXISTS idx_zvd_ai_embeddings_lookup;
DROP TABLE IF EXISTS zvd_ai_embeddings;
