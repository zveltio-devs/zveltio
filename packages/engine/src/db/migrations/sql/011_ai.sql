-- Migration 011: AI providers, prompt templates, chat sessions, RAG documents

-- AI provider configurations (DB-stored, editable via Studio)
CREATE TABLE IF NOT EXISTS zv_ai_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,   -- 'openai', 'anthropic', 'ollama', 'custom'
  label TEXT NOT NULL,
  api_key TEXT,                -- encrypted in production
  base_url TEXT,
  default_model TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  is_default BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Prompt templates
CREATE TABLE IF NOT EXISTS zv_prompt_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  system_prompt TEXT NOT NULL,
  user_template TEXT,          -- Handlebars-like {{variable}} placeholders
  variables JSONB DEFAULT '[]', -- [{ name, description, required }]
  category TEXT DEFAULT 'general',
  provider TEXT,               -- preferred provider, null = any
  model TEXT,                  -- preferred model, null = default
  temperature NUMERIC(3,2) DEFAULT 0.7,
  max_tokens INTEGER DEFAULT 2048,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_prompt_templates_category ON zv_prompt_templates(category);

-- AI chat sessions
CREATE TABLE IF NOT EXISTS zv_ai_chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'default',
  model TEXT,
  context TEXT,                -- system message / persona
  messages JSONB NOT NULL DEFAULT '[]',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_ai_chats_user ON zv_ai_chats(user_id, created_at DESC);

-- RAG document chunks (for semantic search)
CREATE TABLE IF NOT EXISTS zv_rag_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  source_url TEXT,
  source_type TEXT DEFAULT 'manual',  -- 'manual', 'url', 'file', 'collection'
  collection TEXT,
  record_id TEXT,
  namespace TEXT DEFAULT 'default',
  metadata JSONB DEFAULT '{}',
  created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zv_rag_documents_namespace ON zv_rag_documents(namespace);
CREATE INDEX IF NOT EXISTS idx_zv_rag_documents_source ON zv_rag_documents(source_type, collection);

-- Default prompt templates
INSERT INTO zv_prompt_templates (name, description, system_prompt, user_template, category)
VALUES
  (
    'sql_helper',
    'Generates SQL queries from natural language',
    'You are a PostgreSQL expert. Generate safe, read-only SQL queries. Return only the SQL, no explanations.',
    'Write a SQL query to: {{request}}',
    'developer'
  ),
  (
    'content_writer',
    'Writes content based on a brief',
    'You are a professional content writer. Write clear, engaging content following the instructions.',
    'Write {{type}} about: {{topic}}\n\nTone: {{tone}}\nLength: {{length}} words',
    'content'
  ),
  (
    'summarizer',
    'Summarizes long text',
    'You are a text summarizer. Create concise, accurate summaries preserving key information.',
    'Summarize the following text in {{length}} words:\n\n{{text}}',
    'general'
  )
ON CONFLICT (name) DO NOTHING;

-- DOWN
DROP INDEX IF EXISTS idx_zv_rag_documents_source;
DROP INDEX IF EXISTS idx_zv_rag_documents_namespace;
DROP TABLE IF EXISTS zv_rag_documents;
DROP INDEX IF EXISTS idx_zv_ai_chats_user;
DROP TABLE IF EXISTS zv_ai_chats;
DROP INDEX IF EXISTS idx_zv_prompt_templates_category;
DROP TABLE IF EXISTS zv_prompt_templates;
DROP TABLE IF EXISTS zv_ai_providers;
