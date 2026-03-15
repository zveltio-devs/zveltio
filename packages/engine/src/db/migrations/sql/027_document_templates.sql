-- Migration: 027_document_templates
-- Admin-managed document templates + generation history

CREATE TABLE IF NOT EXISTS zv_document_templates (
  id            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT    NOT NULL,
  description   TEXT,
  template_type TEXT    NOT NULL DEFAULT 'html', -- html | markdown | handlebars | mustache
  output_format TEXT    NOT NULL DEFAULT 'pdf',  -- pdf | docx | html | markdown | txt
  content       TEXT    NOT NULL DEFAULT '',
  variables     JSONB   NOT NULL DEFAULT '{}',
  style_config  JSONB   NOT NULL DEFAULT '{}',
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zv_document_generations (
  id            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id   UUID    REFERENCES zv_document_templates(id) ON DELETE SET NULL,
  user_id       TEXT    REFERENCES "user"(id) ON DELETE SET NULL,
  variables     JSONB   NOT NULL DEFAULT '{}',
  output_format TEXT    NOT NULL DEFAULT 'pdf',
  status        TEXT    NOT NULL DEFAULT 'completed',
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_doc_generations_template ON zv_document_generations(template_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_doc_generations_user ON zv_document_generations(user_id);

-- DOWN
DROP INDEX IF EXISTS idx_doc_generations_user;
DROP INDEX IF EXISTS idx_doc_generations_template;
DROP TABLE IF EXISTS zv_document_generations;
DROP TABLE IF EXISTS zv_document_templates;
