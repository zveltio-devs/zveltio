-- S5-07 — Electric SQL replication scaffolding.
--
-- Electric SQL streams Postgres changes to clients via a logical
-- replication slot. For a table to be eligible, it must:
--   1. Be added to a PUBLICATION (we use `zveltio_electric`).
--   2. Have `REPLICA IDENTITY FULL` so updates carry the full row image
--      (Electric needs the prior values for conflict resolution).
--
-- This migration creates the publication AND sets the default replica
-- identity policy. It does NOT add any tables to the publication; the
-- engine's `electric.ts` route does that lazily when a client requests
-- sync of a specific collection (so the publication only grows when
-- something actually needs it — replication slots have real cost).
--
-- Operators standing up Electric run this migration as part of their
-- normal `bun run migrate` flow; no manual SQL required.
--
-- ── Replication slot creation is INTENTIONALLY NOT here ────────────────
-- The slot is created by the Electric service itself on first connect.
-- Pre-creating it here would orphan it on engines that never deploy
-- Electric. Operators who choose CRDT instead pay zero overhead.

DO $$
BEGIN
  -- Create the publication if it doesn't exist. CREATE PUBLICATION
  -- IF NOT EXISTS isn't supported on older PG versions, so we use the
  -- DO block + pg_publication catalog lookup pattern.
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'zveltio_electric') THEN
    CREATE PUBLICATION zveltio_electric;
  END IF;
END$$;

-- Helper function operators call to add a user collection to the
-- publication + set its replica identity. Safe to call repeatedly.
--
-- Usage (from the engine, after a client requests sync):
--   SELECT zv_electric_enable_table('zvd_contacts');
CREATE OR REPLACE FUNCTION zv_electric_enable_table(table_name TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  qualified TEXT;
BEGIN
  -- Guard against SQL injection — table names must match our naming
  -- convention (zvd_ prefix + safe identifier chars only).
  IF table_name !~ '^[a-z][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'Invalid table name %', table_name;
  END IF;
  qualified := quote_ident(table_name);

  -- ALTER TABLE ... REPLICA IDENTITY FULL is idempotent — calling it
  -- a second time is a no-op.
  EXECUTE format('ALTER TABLE %s REPLICA IDENTITY FULL', qualified);

  -- Add to publication. ALTER PUBLICATION ... ADD TABLE throws on
  -- duplicate, so check first via pg_publication_tables.
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'zveltio_electric' AND tablename = table_name
  ) THEN
    EXECUTE format('ALTER PUBLICATION zveltio_electric ADD TABLE %s', qualified);
  END IF;
END$$;

-- Inverse helper — removes a table from the publication. Called when
-- a collection is dropped (so the publication doesn't dangle).
CREATE OR REPLACE FUNCTION zv_electric_disable_table(table_name TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  qualified TEXT;
BEGIN
  IF table_name !~ '^[a-z][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'Invalid table name %', table_name;
  END IF;
  qualified := quote_ident(table_name);
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'zveltio_electric' AND tablename = table_name
  ) THEN
    EXECUTE format('ALTER PUBLICATION zveltio_electric DROP TABLE %s', qualified);
  END IF;
END$$;

-- DOWN
DROP FUNCTION IF EXISTS zv_electric_disable_table(TEXT);
DROP FUNCTION IF EXISTS zv_electric_enable_table(TEXT);
DROP PUBLICATION IF EXISTS zveltio_electric;
