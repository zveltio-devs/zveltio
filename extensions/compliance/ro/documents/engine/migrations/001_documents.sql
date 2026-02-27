-- Romanian compliance documents
CREATE TABLE IF NOT EXISTS zv_ro_documents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type         TEXT NOT NULL,  -- contract, pv, nir, dispozitie_plata, proces_verbal, notificare
  number       TEXT NOT NULL,
  date         DATE NOT NULL,
  title        TEXT NOT NULL,
  parties      JSONB NOT NULL DEFAULT '[]',  -- [{name, cui, role}]
  content      TEXT,           -- document body / template rendered
  template_id  TEXT,
  metadata     JSONB NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'draft',  -- draft, signed, archived
  file_url     TEXT,           -- uploaded PDF/DOCX
  signed_at    TIMESTAMPTZ,
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zv_ro_document_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  description TEXT,
  template    TEXT NOT NULL,  -- Handlebars/Mustache template
  variables   JSONB NOT NULL DEFAULT '[]',
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ro_docs_type ON zv_ro_documents(type, date DESC);
CREATE INDEX IF NOT EXISTS idx_ro_docs_status ON zv_ro_documents(status);

-- Seed document templates
INSERT INTO zv_ro_document_templates (name, type, description, template) VALUES
  ('Contract de prestari servicii', 'contract', 'Standard service agreement', '...template...'),
  ('Proces verbal de receptie', 'pv', 'Reception protocol', '...template...'),
  ('NIR - Nota de intrare receptie', 'nir', 'Goods receipt note', '...template...')
ON CONFLICT DO NOTHING;
