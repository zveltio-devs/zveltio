-- Per-field encryption support (no schema change required)
-- The encrypted flag is stored inside the fields JSONB column of zv_collections.
-- Encryption/decryption is handled entirely in the engine (field-crypto.ts).
-- Requires env var: FIELD_ENCRYPTION_KEY (openssl rand -hex 32)

-- Helper view: lists all encrypted fields across all collections
-- Created after zv_collections (migration 002) to avoid dependency issues.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'zv_collections') THEN
    EXECUTE '
      CREATE OR REPLACE VIEW zv_encrypted_fields AS
      SELECT
        c.name AS collection,
        f->>''name'' AS field_name,
        f->>''type'' AS field_type
      FROM zv_collections c,
        jsonb_array_elements(c.fields) AS f
      WHERE (f->>''encrypted'')::boolean = true
    ';
  END IF;
END $$;

-- DOWN
-- DROP VIEW IF EXISTS zv_encrypted_fields;
