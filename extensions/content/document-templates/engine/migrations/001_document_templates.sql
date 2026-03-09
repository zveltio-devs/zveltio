-- Document Templates Extension
-- HTML/PDF template management with variable interpolation

CREATE TABLE IF NOT EXISTS zv_document_templates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  description   TEXT,
  category      TEXT,
  -- Template content
  html_body     TEXT NOT NULL DEFAULT '',
  css_styles    TEXT,
  -- Variable schema: [{ name, label, type, required, default }]
  variables     JSONB NOT NULL DEFAULT '[]',
  -- PDF rendering options
  pdf_options   JSONB DEFAULT '{"format":"A4","margin":{"top":"20mm","bottom":"20mm","left":"20mm","right":"20mm"}}',
  -- Metadata
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_by    TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS zv_document_renders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id   UUID NOT NULL REFERENCES zv_document_templates(id) ON DELETE CASCADE,
  -- Resolved variable values used for this render
  variables     JSONB NOT NULL DEFAULT '{}',
  -- Output
  output_format TEXT NOT NULL DEFAULT 'pdf' CHECK (output_format IN ('pdf', 'html')),
  file_key      TEXT,   -- SeaweedFS key if stored
  file_size     INTEGER,
  rendered_by   TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  rendered_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_doc_templates_slug ON zv_document_templates(slug);
CREATE INDEX IF NOT EXISTS idx_doc_renders_template ON zv_document_renders(template_id);
