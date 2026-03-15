-- Virtual Collections: proxy to external APIs (Stripe, Shopify, ERP, etc.)
ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'table'
  CHECK (source_type IN ('table', 'virtual'));
ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS virtual_config jsonb;

COMMENT ON COLUMN zvd_collections.source_type IS 'table = PostgreSQL backed, virtual = external API proxy';
COMMENT ON COLUMN zvd_collections.virtual_config IS 'VirtualConfig JSON: source_url, auth_type, auth_value, field_mapping, list_path, id_field';

-- DOWN
ALTER TABLE zvd_collections DROP COLUMN IF EXISTS virtual_config;
ALTER TABLE zvd_collections DROP COLUMN IF EXISTS source_type;
