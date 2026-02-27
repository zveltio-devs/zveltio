-- Checklist templates (reusable definitions)
CREATE TABLE IF NOT EXISTS zv_checklist_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  collection  TEXT, -- null = global template
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Items within a template
CREATE TABLE IF NOT EXISTS zv_checklist_template_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES zv_checklist_templates(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  description TEXT,
  required    BOOLEAN NOT NULL DEFAULT false,
  order_idx   INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Checklist instances attached to records
CREATE TABLE IF NOT EXISTS zv_checklists (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id  UUID REFERENCES zv_checklist_templates(id) ON DELETE SET NULL,
  collection   TEXT NOT NULL,
  record_id    UUID NOT NULL,
  name         TEXT NOT NULL,
  created_by   UUID,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Individual check items on a checklist instance
CREATE TABLE IF NOT EXISTS zv_checklist_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checklist_id UUID NOT NULL REFERENCES zv_checklists(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  description  TEXT,
  required     BOOLEAN NOT NULL DEFAULT false,
  order_idx    INTEGER NOT NULL DEFAULT 0,
  checked      BOOLEAN NOT NULL DEFAULT false,
  checked_by   UUID,
  checked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_checklists_record ON zv_checklists(collection, record_id);
CREATE INDEX IF NOT EXISTS idx_checklist_items_checklist ON zv_checklist_items(checklist_id);
