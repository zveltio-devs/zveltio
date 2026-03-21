CREATE TABLE IF NOT EXISTS zv_search_indexes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'meilisearch',  -- meilisearch | typesense
  index_name TEXT NOT NULL,
  searchable_fields TEXT[] NOT NULL DEFAULT '{}',
  filterable_fields TEXT[] NOT NULL DEFAULT '{}',
  sortable_fields TEXT[] NOT NULL DEFAULT '{}',
  last_synced_at TIMESTAMPTZ,
  record_count INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
