-- Migration: 002_insights_panels_title
--
-- Fixes the `zv_panels.title` gap left by 069_insights_reconcile in
-- 001_initial.sql. The original reconcile added missing dashboard columns
-- after 026/067 schema divergence, but forgot panels: 026 created the
-- table with `name TEXT NOT NULL` and 067 wanted `title TEXT NOT NULL`,
-- but only 067's CREATE TABLE was a no-op (table existed) and 069 only
-- reconciled dashboards.
--
-- Every fresh install before this migration ended up with `zv_panels.name`
-- (NOT NULL) and no `title` column, so /api/insights/panels INSERT/UPDATE
-- handlers (which use `title`) 500ed at runtime with
-- "column title does not exist".
--
-- The reconcile in 001_initial.sql is updated to do this on fresh installs;
-- this migration is the same operation for installs that already applied
-- 001_initial.sql (alpha.99 through alpha.101 inclusive).

ALTER TABLE zv_panels ADD COLUMN IF NOT EXISTS title TEXT;
UPDATE zv_panels SET title = name WHERE title IS NULL AND name IS NOT NULL;
ALTER TABLE zv_panels ALTER COLUMN name DROP NOT NULL;
