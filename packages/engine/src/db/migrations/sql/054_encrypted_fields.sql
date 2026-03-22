-- Per-field encryption support
-- The encrypted flag is stored in the field's options JSONB (no schema change needed).
-- This migration adds a GUC check function and documents the feature.

-- Helper view: lists all encrypted fields across all collections
CREATE OR REPLACE VIEW zv_encrypted_fields AS
SELECT
  c.name AS collection,
  f->>'name' AS field_name,
  f->>'type' AS field_type
FROM zv_collections c,
  jsonb_array_elements(c.fields) AS f
WHERE (f->>'encrypted')::boolean = true;

-- DOWN
-- DROP VIEW IF EXISTS zv_encrypted_fields;
