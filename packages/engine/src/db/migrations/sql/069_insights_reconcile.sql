-- Migration: 069_insights_reconcile
--
-- Some installs already had zv_dashboards/zv_panels created by the older
-- analytics/insights extension, with a slightly different schema (no
-- is_public, no tags, etc.). The CREATE TABLE IF NOT EXISTS in 067 was a
-- no-op for those installs and the new code paths fail with "column does
-- not exist".
--
-- ALTER TABLE … ADD COLUMN IF NOT EXISTS is idempotent — fresh installs that
-- already have the columns from migration 067 see this run as a no-op too.

ALTER TABLE zv_dashboards
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS layout JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_by TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE zv_panels
  ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS position JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS refresh_interval INT;
