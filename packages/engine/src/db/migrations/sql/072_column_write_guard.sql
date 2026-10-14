-- 072_column_write_guard.sql
--
-- Column write permissions, enforced by the database too (L37, layer 1).
--
-- `zvd_column_permissions` was applied only by the engine's own filter
-- (`filterWritableFields`), so a path that skipped it wrote the column anyway:
-- sync push did exactly that until it was patched by hand, and an extension's
-- `ctx.db` never met the filter at all. The filter stays — it answers with a
-- clean 403 naming the fields — and this is the net under it.
--
-- One generic function; each collection table that has a write restriction
-- gets a BEFORE INSERT OR UPDATE trigger whose argument is the restriction,
-- compiled from `zvd_column_permissions` by the engine
-- (`lib/data/column-guard.ts`) and rebuilt on every change, as the row-rule
-- policy is from `zvd_rls_policies`. The argument is
--
--   {"roles": {"<role>": ["<column>" | "*", ...], ...}, "system": [...]}
--
-- with a column listed for a role when `NOT can_read OR NOT can_write` — a
-- hidden column is not writable either, as in the engine. It reads the actor
-- from the settings the row rules read and stands down where they do:
--
--   no actor                the engine's own work: boot, reconcilers, jobs;
--   pg_trigger_depth() > 1  a write the schema itself causes (an ON DELETE
--                           SET NULL, a trigger's own statement), not a value
--                           the caller chose;
--   zveltio.columns_all     the engine's `data:view_all_columns` exemption
--                           (a god holds it), published per request;
--   system_collections      an extension inside `asSystem` (058's rule 2).
--
-- Otherwise the columns listed for `zveltio.user_role` — the same single role
-- `getColumnAccess` is asked with — and for `*` are checked:
--
--   UPDATE  the value must not change. A no-op write passes, where the engine
--           refuses the field merely being present: the net catches changes.
--   INSERT  the value must be the column's DEFAULT (NULL when it has none),
--           evaluated here, so a column the caller left out passes. A default
--           that is not reproducible (gen_random_uuid()) cannot be told from a
--           chosen value, and that column is not checked on INSERT.
--
-- The system columns (`SYSTEM_COLUMNS`, passed in the argument) are never
-- checked: the engine sets them itself and the data API never takes them from
-- the caller.
--
-- Denied with 42501 and CONSTRAINT `zv_column_guard`; `mapPgError` answers 403.
--
-- Values are compared as jsonb by name, so a trigger argument naming a column
-- that was dropped or renamed since reads null on both sides instead of
-- failing every write until the rebuild.
--
-- Measured on Postgres 18, 20 000 rows: a restricted caller pays +28 µs per row
-- updated and +86 µs per row inserted (catalog read + EXECUTE of the defaults);
-- an exempt one +2 µs; a table with no restriction carries no trigger.
-- ponytail: generic plpgsql; a per-table compiled function is the upgrade if
-- bulk writes by restricted roles ever matter.
--
-- Not SECURITY DEFINER: it reads settings and the catalog. search_path pinned
-- as 069 pins its helpers; a default's text is printed and run under it.

CREATE OR REPLACE FUNCTION zveltio_column_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  spec jsonb;
  sys text;
  cols text[];
  skip text[];
  n jsonb;
  o jsonb;
  q text;
  d1 jsonb;
  d2 jsonb;
  bad text[];
BEGIN
  IF coalesce(current_setting('zveltio.actor', true), '') <> 'on' OR pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;
  IF coalesce(current_setting('zveltio.columns_all', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  sys := coalesce(current_setting('zveltio.system_collections', true), '');
  IF sys <> '' AND (strpos(sys, ',' || substr(TG_TABLE_NAME, 5) || ',') > 0 OR strpos(sys, ',*,') > 0) THEN
    RETURN NEW;
  END IF;

  spec := TG_ARGV[0]::jsonb;
  SELECT array_agg(DISTINCT c) INTO cols
    FROM jsonb_array_elements_text(
           coalesce(spec->'roles'->coalesce(current_setting('zveltio.user_role', true), ''), '[]'::jsonb)
           || coalesce(spec->'roles'->'*', '[]'::jsonb)) c;
  IF cols IS NULL THEN
    RETURN NEW;
  END IF;

  skip := ARRAY(SELECT jsonb_array_elements_text(spec->'system'));
  n := to_jsonb(NEW) - skip;
  IF '*' = ANY (cols) THEN
    cols := ARRAY(SELECT jsonb_object_keys(n));
  END IF;

  IF TG_OP = 'UPDATE' THEN
    o := to_jsonb(OLD) - skip;
    bad := ARRAY(SELECT c FROM unnest(cols) c
                  WHERE n->c IS NOT NULL AND n->c IS DISTINCT FROM o->c ORDER BY c);
  ELSE
    SELECT string_agg(format('(%s)::%s AS %I', pg_get_expr(ad.adbin, ad.adrelid),
                             format_type(a.atttypid, a.atttypmod), a.attname), ', ')
      INTO q
      FROM pg_attribute a
      JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
     WHERE a.attrelid = TG_RELID AND a.attname = ANY (cols)
       AND NOT a.attisdropped AND a.attgenerated = '';
    IF q IS NOT NULL THEN
      -- Twice, in one statement: a default that differs from itself is volatile.
      EXECUTE format('SELECT to_jsonb(x), to_jsonb(y) FROM (SELECT %s) x, (SELECT %s) y', q, q)
        INTO d1, d2;
    END IF;
    bad := ARRAY(SELECT c FROM unnest(cols) c
                  WHERE n->c IS NOT NULL
                    AND (d1->c IS NOT DISTINCT FROM d2->c)
                    AND n->c IS DISTINCT FROM coalesce(d1->c, 'null'::jsonb)
                  ORDER BY c);
  END IF;

  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION 'column-level permission denies writing % on %',
                    array_to_string(bad, ', '), TG_TABLE_NAME
      USING ERRCODE = '42501', CONSTRAINT = 'zv_column_guard',
            TABLE = TG_TABLE_NAME, COLUMN = bad[1];
  END IF;
  RETURN NEW;
END
$fn$;

GRANT EXECUTE ON FUNCTION zveltio_column_guard() TO PUBLIC;

-- DOWN

-- CASCADE takes the `_zv_column_guard` trigger off every collection table: it
-- calls the function. The boot reconciler puts them back when 072 runs again.
DROP FUNCTION IF EXISTS zveltio_column_guard() CASCADE;
