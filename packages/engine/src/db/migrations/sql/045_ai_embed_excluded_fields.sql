-- 050_ai_embed_excluded_fields.sql
-- Adds per-collection field-level PII control for AI embeddings.
--
-- Problem: when ai_search_field is NULL, triggerEmbedding concatenates ALL
-- string fields, potentially sending PII (CNP, salary, address…) to the AI
-- provider. This column lets admins explicitly exclude sensitive fields while
-- keeping the "embed everything" convenience for non-sensitive collections.
--
-- Usage: set ai_embed_excluded_fields = ARRAY['cnp','salary','phone'] on the
-- collection. Fields in this list are stripped before text is sent for embedding.

ALTER TABLE zvd_collections
  ADD COLUMN IF NOT EXISTS ai_embed_excluded_fields TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN zvd_collections.ai_embed_excluded_fields IS
  'Field names excluded from AI embedding (PII/sensitive data control). '
  'Applied when ai_search_field is NULL (full-record embedding mode). '
  'Example: ARRAY[''cnp'',''salary'',''iban'']';

-- DOWN
-- ALTER TABLE zvd_collections DROP COLUMN IF EXISTS ai_embed_excluded_fields;
