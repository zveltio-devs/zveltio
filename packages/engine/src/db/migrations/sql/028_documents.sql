-- Migration: 028_documents
-- RO compliance document templates + generated document records

CREATE TABLE IF NOT EXISTS zv_doc_templates (
  id                UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT    NOT NULL,
  type              TEXT    NOT NULL,                         -- contract | pv | nir | etc.
  description       TEXT,
  template_html     TEXT    NOT NULL DEFAULT '',
  template_text     TEXT,
  variables         JSONB   NOT NULL DEFAULT '[]',            -- array of variable definitions
  source_collection TEXT,
  field_mapping     JSONB   NOT NULL DEFAULT '{}',            -- varName -> fieldName
  prefix            TEXT    NOT NULL DEFAULT '',
  counter           INT     NOT NULL DEFAULT 0,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_by        TEXT    REFERENCES "user"(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zv_generated_docs (
  id                UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id       UUID    REFERENCES zv_doc_templates(id) ON DELETE SET NULL,
  template_name     TEXT    NOT NULL,
  source_collection TEXT,
  source_record_id  TEXT,
  document_number   TEXT    NOT NULL DEFAULT '',
  variables_data    JSONB   NOT NULL DEFAULT '{}',
  html_content      TEXT,
  generated_by      TEXT    REFERENCES "user"(id) ON DELETE SET NULL,
  generated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_doc_templates_type ON zv_doc_templates(type, is_active);
CREATE INDEX IF NOT EXISTS idx_generated_docs_template ON zv_generated_docs(template_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_generated_docs_source ON zv_generated_docs(source_collection, source_record_id);

-- DOWN
DROP INDEX IF EXISTS idx_generated_docs_source;
DROP INDEX IF EXISTS idx_generated_docs_template;
DROP TABLE IF EXISTS zv_generated_docs;
DROP INDEX IF EXISTS idx_doc_templates_type;
DROP TABLE IF EXISTS zv_doc_templates;
