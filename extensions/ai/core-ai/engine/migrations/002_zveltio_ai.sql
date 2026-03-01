-- AI chat history (Z-AI agent conversations)
CREATE TABLE IF NOT EXISTS zv_ai_chat_history (
  id              UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id TEXT  NOT NULL,
  user_id         TEXT  NOT NULL,
  role            TEXT  NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT  NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_chat_conv  ON zv_ai_chat_history(conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_ai_chat_user  ON zv_ai_chat_history(user_id, created_at DESC);

-- AI features configuration (enable/disable per-feature)
CREATE TABLE IF NOT EXISTS zv_ai_features (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_key TEXT    NOT NULL UNIQUE,
  display_name TEXT   NOT NULL,
  description  TEXT,
  is_enabled   BOOLEAN NOT NULL DEFAULT true,
  config       JSONB   NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO zv_ai_features (feature_key, display_name, description, is_enabled) VALUES
  ('chat',        'AI Chat',              'Conversational AI assistant',                     true),
  ('embeddings',  'Embeddings',           'Generate text embeddings for semantic search',    true),
  ('schema_gen',  'Schema Generator',     'Generate collections from natural language',      true),
  ('data_quality','Data Quality',         'AI-powered data quality analysis',                true),
  ('zveltio_ai',  'Zveltio AI Agent',     'Agentic AI that can query and manage data',       true)
ON CONFLICT (feature_key) DO NOTHING;

-- AI embeddings store for semantic search (text content + metadata holding the vector)
CREATE TABLE IF NOT EXISTS zv_ai_embeddings (
  id           UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  collection   TEXT  NOT NULL,
  record_id    TEXT  NOT NULL,
  field_name   TEXT  NOT NULL DEFAULT 'content',
  content      TEXT  NOT NULL,
  metadata     JSONB NOT NULL DEFAULT '{}',  -- stores serialised embedding vector + model info
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (collection, record_id, field_name)
);

CREATE INDEX IF NOT EXISTS idx_embeddings_collection ON zv_ai_embeddings(collection, record_id);
