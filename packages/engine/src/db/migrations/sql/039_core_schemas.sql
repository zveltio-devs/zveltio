-- 039_core_schemas.sql
-- Adds the system/lock flags to zvd_collections that the DDLManager bootstrap
-- needs before it can insert core collection rows (contacts, organizations,
-- transactions). The tables themselves are NOT created here — they are created
-- at boot by ensureCoreCollections() via DDLManager.createCollection(), which
-- is the same code path the Studio UI uses. Single source of truth.
--
-- See packages/engine/src/core-collections/index.ts for the definitions and
-- packages/engine/src/lib/ddl-manager.ts for the creation path.
--
-- Historical context: earlier alpha builds populated these three tables with
-- raw CREATE TABLE + INSERT statements here. That bypassed DDLManager and left
-- zvd_collections.fields=[], which made Studio cascade-fetch the API trying to
-- discover the schema (hitting the 200/min rate limit with 429s). The healer
-- in ddl-queue.ts covers the upgrade path for installs that still have the
-- bad rows.

ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS is_system     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE zvd_collections ADD COLUMN IF NOT EXISTS schema_locked BOOLEAN NOT NULL DEFAULT false;

-- DOWN
ALTER TABLE zvd_collections DROP COLUMN IF EXISTS schema_locked;
ALTER TABLE zvd_collections DROP COLUMN IF EXISTS is_system;
