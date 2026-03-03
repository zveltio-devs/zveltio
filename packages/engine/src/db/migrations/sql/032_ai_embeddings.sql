-- 032_ai_embeddings.sql
-- pgvector + tabel de embeddings pentru AI Search

-- Activăm extensia pgvector (necesită PostgreSQL cu pgvector instalat)
CREATE EXTENSION IF NOT EXISTS vector;

-- Tabel de embeddings per record per câmp
CREATE TABLE IF NOT EXISTS zvd_ai_embeddings (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  collection   TEXT        NOT NULL,
  record_id    TEXT        NOT NULL,
  field        TEXT        NOT NULL DEFAULT '_auto',  -- câmpul embedduit sau '_auto' = toate
  text_content TEXT        NOT NULL DEFAULT '',       -- textul care a generat embedding-ul
  embedding    vector(1536),                          -- OpenAI text-embedding-3-small dimension
  model        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (collection, record_id, field)
);

CREATE INDEX IF NOT EXISTS idx_zvd_ai_embeddings_lookup
  ON zvd_ai_embeddings (collection, record_id);

-- Index cosine similarity (IVFFlat — necesită minim 1 rând în tabel pentru a fi util)
-- Creat cu lists=100; ajustează la nr_rânduri/1000 în producție
CREATE INDEX IF NOT EXISTS idx_zvd_ai_embeddings_ivfflat
  ON zvd_ai_embeddings USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Coloane AI Search pe zvd_collections
ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS ai_search_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS ai_search_field   TEXT    DEFAULT NULL;

COMMENT ON COLUMN zvd_collections.ai_search_enabled IS 'Activează auto-embedding la create/update';
COMMENT ON COLUMN zvd_collections.ai_search_field   IS 'Câmpul de embedduit; NULL = concat toate câmpurile text';
