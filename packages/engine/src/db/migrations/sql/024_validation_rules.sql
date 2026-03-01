-- Migration: 024_validation_rules
-- Field-level validation rules with NL generation support

CREATE TABLE IF NOT EXISTS zv_validation_rules (
  id             UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  collection     TEXT    NOT NULL,
  field_name     TEXT    NOT NULL,
  rule_type      TEXT    NOT NULL,
  nl_description TEXT,
  rule_config    JSONB   NOT NULL DEFAULT '{}',
  error_message  TEXT    NOT NULL,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_by     TEXT    REFERENCES "user"(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_validation_rules_collection ON zv_validation_rules(collection, field_name);
CREATE INDEX IF NOT EXISTS idx_validation_rules_active     ON zv_validation_rules(collection) WHERE is_active = true;
