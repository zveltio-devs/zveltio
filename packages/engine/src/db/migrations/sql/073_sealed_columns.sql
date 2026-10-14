-- 073_sealed_columns.sql
--
-- A column whose value is served to no one cannot be read by the request roles
-- either (L37, layer 2).
--
-- A `password` field holds an argon2 hash that the data API strips from every
-- payload, god's included (`withheldColumns().unserved`). Stripping is the
-- engine remembering to; raw SQL on `zveltio_rls` — or on the narrower roles
-- extensions and flows run as — read the hash back. This takes SELECT on such a
-- column away from every role but the table's owner.
--
-- Postgres has no column-level REVOKE beside a table-level grant: a table grant
-- covers every column. So a sealed table's grantees hold SELECT column by
-- column, on every column but the sealed ones, and keep their table-level
-- INSERT, UPDATE and DELETE (writing the hash needs no SELECT on it). `SELECT *`
-- is then refused (42501); the engine names the columns it may read
-- (`db/dynamic.ts: readableColumns`).
--
-- `zveltio_seal_columns(rel, sealed)` puts a table into that shape, idempotent
-- and touching the ACL only when it is not already there:
--
--   sealed  the columns to seal; '{}' gives every column-scoped grantee its
--           table-level SELECT back (the last sealed field was dropped).
--   NULL    the columns `zveltio_rls` may not read — the shape the request role
--           already has. A grant site that just gave a role the whole table
--           (an extension's role, the narrow roles) calls it this way, so the
--           role ends up exactly where `zveltio_rls` is.
--
-- The engine decides which columns are sealed (the field type registry) and
-- calls it on collection create, on every field change and at boot.
--
-- Not SECURITY DEFINER: only the owner may grant on its tables, and only the
-- owner calls it.

CREATE OR REPLACE FUNCTION zveltio_seal_columns(rel regclass, sealed text[] DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  keep text[];
  g record;
  held text[];
  whole boolean;
  who text;
  changed boolean := false;
BEGIN
  IF rel IS NULL THEN
    RETURN false;
  END IF;
  IF sealed IS NULL THEN
    IF to_regrole('zveltio_rls') IS NULL
       OR has_table_privilege('zveltio_rls', rel, 'SELECT')
       OR NOT has_any_column_privilege('zveltio_rls', rel, 'SELECT') THEN
      sealed := '{}';
    ELSE
      SELECT coalesce(array_agg(attname::text), '{}') INTO sealed
        FROM pg_attribute
       WHERE attrelid = rel AND attnum > 0 AND NOT attisdropped
         AND NOT has_column_privilege('zveltio_rls', rel, attnum, 'SELECT');
    END IF;
  END IF;

  SELECT coalesce(array_agg(attname::text ORDER BY attnum), '{}') INTO keep
    FROM pg_attribute
   WHERE attrelid = rel AND attnum > 0 AND NOT attisdropped AND NOT (attname = ANY (sealed));

  -- Every role but the owner that may SELECT the table or any column of it.
  FOR g IN
    SELECT a.grantee
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE c.oid = rel AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner
    UNION
    SELECT a.grantee
      FROM pg_class c
      JOIN pg_attribute t ON t.attrelid = c.oid AND NOT t.attisdropped
      CROSS JOIN LATERAL aclexplode(t.attacl) a
     WHERE c.oid = rel AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner
  LOOP
    whole := EXISTS (
      SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
       WHERE c.oid = rel AND a.grantee = g.grantee AND a.privilege_type = 'SELECT');
    held := ARRAY(
      SELECT t.attname::text
        FROM pg_attribute t CROSS JOIN LATERAL aclexplode(t.attacl) a
       WHERE t.attrelid = rel AND NOT t.attisdropped
         AND a.grantee = g.grantee AND a.privilege_type = 'SELECT'
       ORDER BY t.attnum);
    CONTINUE WHEN cardinality(sealed) = 0 AND whole;
    CONTINUE WHEN cardinality(sealed) > 0 AND NOT whole AND held = keep;

    -- Two rebuilds of one table serialize here instead of failing with
    -- "tuple concurrently updated" on its ACL.
    IF NOT changed THEN
      EXECUTE format('LOCK TABLE %s IN SHARE ROW EXCLUSIVE MODE', rel);
      changed := true;
    END IF;
    who := CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(g.grantee)) END;
    -- A table-level REVOKE takes the column-level SELECTs with it.
    EXECUTE format('REVOKE SELECT ON %s FROM %s', rel, who);
    IF cardinality(sealed) = 0 THEN
      EXECUTE format('GRANT SELECT ON %s TO %s', rel, who);
    ELSIF cardinality(keep) > 0 THEN
      EXECUTE format('GRANT SELECT (%s) ON %s TO %s',
        (SELECT string_agg(quote_ident(k), ', ') FROM unnest(keep) k), rel, who);
    END IF;
  END LOOP;
  RETURN changed;
END
$fn$;

REVOKE ALL ON FUNCTION zveltio_seal_columns(regclass, text[]) FROM PUBLIC;

-- DOWN

-- The engine below 073 reads with `SELECT *`: every sealed table goes back to
-- table-level SELECT for its grantees before the function goes.
DO $down$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT c.oid::regclass AS rel
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute t ON t.attrelid = c.oid AND t.attacl IS NOT NULL
      JOIN zvd_collections z ON 'zvd_' || z.name = c.relname
     WHERE n.nspname = 'public'
  LOOP
    PERFORM zveltio_seal_columns(r.rel, '{}');
  END LOOP;
END
$down$;
DROP FUNCTION IF EXISTS zveltio_seal_columns(regclass, text[]);
