-- Migration: 006_extension_load_errors
--
-- Persist per-extension load failures so they survive a restart and surface
-- in /api/extensions (marketplace red badge + reason) instead of being a
-- silent skip. Previously the loader kept `lastLoadError` only in memory, and
-- the enable handler reacted to a transient hot-load failure by flipping
-- is_enabled=false — permanently disabling extensions that would have loaded
-- fine on the next boot (npm-install timing, dependency order, missing PG ext).
-- With the error persisted, the enable path can keep is_enabled=true and let
-- boot-load self-heal, while the operator still sees what went wrong.

ALTER TABLE zv_extension_registry
  ADD COLUMN IF NOT EXISTS last_load_error TEXT,
  ADD COLUMN IF NOT EXISTS last_load_at    TIMESTAMPTZ;
