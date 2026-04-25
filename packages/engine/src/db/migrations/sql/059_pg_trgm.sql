-- Enable pg_trgm extension for fuzzy/similarity search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Track which collections have trgm search support (search_text column + GIN trgm index)
ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS has_trgm boolean NOT NULL DEFAULT false;
