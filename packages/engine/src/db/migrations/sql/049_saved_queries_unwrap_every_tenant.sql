-- 049_saved_queries_unwrap_every_tenant.sql
--
-- 039's repair of `zv_saved_queries.config`, for every tenant.
--
-- `zv_saved_queries` is under FORCE RLS (004), and 039 ran its UPDATE with no
-- tenant published. A plain owner role — the hardened install
-- scripts/bootstrap-db-role.sh builds, the shape production is meant to run —
-- then sees only the default tenant's rows (or none, with
-- zveltio.fail_closed_tenant on). Measured on such an install upgraded from
-- beta.76: the default tenant's saved queries were unwrapped, every other
-- tenant's stayed jsonb strings, and 039 was recorded as applied, so nothing
-- would ever repair them. `zv_audit_log.metadata`, the other half of 039, had no
-- policy until 040 and was repaired in full.
--
-- One tenant at a time, as that tenant: the policy's WITH CHECK lets a row land
-- only in the transaction's own tenant, so publishing every tenant would let
-- the UPDATE read the rows and then refuse to write them.
--
-- Row by row, inside a loop, and no pg_temp helper: a text that does not parse
-- is skipped (22P02) instead of failing the upgrade, and nothing here needs the
-- TEMPORARY privilege. The table holds saved queries, not data, so the per-row
-- cost is small.
--
-- Re-runnable: an unwrapped row is no longer a string and is not selected.

DO $$
DECLARE
  t uuid;
  r record;
BEGIN
  PERFORM set_config('zveltio.visible_tenants', '', true);
  FOR t IN SELECT id FROM zv_tenants LOOP
    PERFORM set_config('zveltio.current_tenant', t::text, true);
    FOR r IN
      SELECT id, config #>> '{}' AS txt FROM zv_saved_queries
       WHERE jsonb_typeof(config) = 'string'
         AND left(ltrim(config #>> '{}'), 1) IN ('{', '[')
    LOOP
      BEGIN
        UPDATE zv_saved_queries SET config = r.txt::jsonb WHERE id = r.id;
      EXCEPTION WHEN invalid_text_representation THEN
        NULL;
      END;
    END LOOP;
  END LOOP;
  PERFORM set_config('zveltio.current_tenant', '', true);
END $$;

-- DOWN

-- Deliberately a no-op, as 039's: re-wrapping objects into strings would only
-- restore the defect.
SELECT 1;
