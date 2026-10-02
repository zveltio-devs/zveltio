-- 036_collection_unique_keys_per_tenant.sql
--
-- A collection's `unique: true` field is unique per tenant.
--
-- The field builder wrote a column-level `UNIQUE`, so every collection table
-- created with a unique field has `UNIQUE (<field>)` across all of its rows —
-- and every collection table holds every tenant's rows (`tenant_id`, FORCE RLS).
-- Tenant B could not store a value tenant A held, was refused over a row its
-- RLS hides, and the refusal told B that some other company has that email or
-- code. The builders write `UNIQUE (tenant_id, <field>)` now; this rewrites the
-- keys already out there.
--
-- WHAT IS REWRITTEN
--
-- A single-column UNIQUE constraint on the table of a registered collection
-- (`zvd_collections`), other than on `tenant_id`, where `tenant_id` is NOT
-- NULL — only the engine's builders ever put one there. Not touched:
--   * extension-owned `zvd_*` tables (not registered as collections): their
--     keys are the extension's, often the target of an `ON CONFLICT (...)` that
--     a wider key would turn into 42P10;
--   * BYOD tables imported with `is_managed = false` (the column exists only
--     when that extension is installed, hence `to_jsonb`);
--   * multi-column keys, unique indexes without a constraint, primary keys.
--
-- No data can violate the new key: `(tenant_id, x)` is unique wherever `(x)`
-- was. Engine ON CONFLICT targets on collection tables are all `(id)`.
--
-- A key some foreign key references cannot be dropped (2BP01); that table keeps
-- its global key and the migration says so rather than failing the upgrade.
--
-- Each rewrite rebuilds that table's index under ACCESS EXCLUSIVE, inside the
-- migration transaction. A dynamic table list cannot use CONCURRENTLY (a DO
-- block is a transaction); these are user-collection keys, built once.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT k.conrelid::regclass AS tbl, k.conname, a.attname
      FROM zvd_collections c
      JOIN pg_constraint k
        ON k.conrelid = to_regclass(quote_ident('zvd_' || c.name))
       AND k.contype = 'u' AND cardinality(k.conkey) = 1
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
      JOIN pg_attribute t ON t.attrelid = k.conrelid AND t.attname = 'tenant_id'
                         AND t.attnotnull AND NOT t.attisdropped
     WHERE a.attname <> 'tenant_id'
       AND COALESCE((to_jsonb(c) ->> 'is_managed')::boolean, true)
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I, ADD UNIQUE (tenant_id, %I)',
                     r.tbl, r.conname, r.attname);
    EXCEPTION WHEN dependent_objects_still_exist THEN
      RAISE WARNING '036: % keeps its global key % — a foreign key references it',
                    r.tbl, r.conname;
    END;
  END LOOP;
END;
$$;

-- DOWN

-- Deliberately a no-op: narrowing back to a global key would fail on any two
-- tenants holding the same value, which this migration exists to allow.
SELECT 1;
