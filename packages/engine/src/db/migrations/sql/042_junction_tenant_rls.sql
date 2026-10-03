-- 042_junction_tenant_rls.sql
--
-- m2m junction tables (`zvd_jnc_{source}_{target}`) get the tenant of the row
-- they link from.
--
-- They were created with no `tenant_id` and no policy while both tables they
-- join are under FORCE RLS. `zveltio_rls` holds DML on every table in `public`,
-- so inside a tenant transaction one tenant read every other tenant's links and
-- could delete them. The engine now creates junctions through `applyTenantRLS`;
-- this backfills the ones that exist. The policy, NOT NULL, indexes and the
-- narrow-role grants follow at boot from `reconcileTenantRLS`, which owns them
-- for collection tables too — this file holds only what a reconciler cannot
-- decide: which tenant an existing link belongs to.
--
-- The source row decides. A link with no source row takes its target's tenant;
-- with neither, the default tenant, as every pre-tenant row did (007). The two
-- FK columns are told apart by position: every road that created a junction
-- declared the source column first.
--
-- Every tenant is published first: a plain owner role is bound by FORCE RLS on
-- the source table and would otherwise see only the default tenant's rows.
--
-- Re-runnable: a junction that already has `tenant_id` is skipped, and so is a
-- collection named `jnc_*` (its table shares the prefix and has `tenant_id`).
--
-- Locking: the ADD is catalogue-only; the UPDATE rewrites the junction under the
-- ACCESS EXCLUSIVE lock the ADD took, until this migration commits. A junction
-- is three uuid columns and a timestamp, so that is short next to any backfill
-- of a collection; the runner's lock_timeout bounds the wait to acquire it.

DO $$
DECLARE
  t record;
  cols text[];
  refs text[];
  keys text[];
  expr text;
BEGIN
  PERFORM set_config(
    'zveltio.visible_tenants',
    coalesce((SELECT string_agg(id::text, ',') FROM zv_tenants), ''),
    true);
  FOR t IN
    SELECT c.oid, c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'zvd\_jnc\_%'
       AND NOT EXISTS (
         SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
  LOOP
    -- Single-column FKs into a table with a uuid tenant_id, in column order.
    SELECT array_agg(a.attname::text ORDER BY a.attnum),
           array_agg(k.confrelid::regclass::text ORDER BY a.attnum),
           array_agg(da.attname::text ORDER BY a.attnum)
      INTO cols, refs, keys
      FROM pg_constraint k
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
      JOIN pg_attribute da ON da.attrelid = k.confrelid AND da.attnum = k.confkey[1]
     WHERE k.conrelid = t.oid AND k.contype = 'f' AND cardinality(k.conkey) = 1
       AND EXISTS (
         SELECT 1 FROM pg_attribute ta
          WHERE ta.attrelid = k.confrelid AND ta.attname = 'tenant_id'
            AND ta.atttypid = 'uuid'::regtype AND NOT ta.attisdropped);

    expr := '';
    FOR i IN 1 .. coalesce(cardinality(cols), 0) LOOP
      expr := expr || format('(SELECT r.tenant_id FROM %s r WHERE r.%I = j.%I), ',
                             refs[i], keys[i], cols[i]);
    END LOOP;

    EXECUTE format('ALTER TABLE public.%I ADD COLUMN tenant_id uuid', t.relname);
    EXECUTE format(
      'UPDATE public.%I j SET tenant_id = COALESCE(%s''00000000-0000-0000-0000-000000000001''::uuid)',
      t.relname, expr);
  END LOOP;
END
$$;

-- DOWN

-- Junctions back to the shape the previous engine created: no policy, no RLS,
-- no tenant_id (its indexes go with the column). Collection tables that share
-- the prefix are left alone.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT p.tablename FROM pg_tables p
     WHERE p.schemaname = 'public' AND p.tablename LIKE 'zvd\_jnc\_%'
       AND NOT EXISTS (SELECT 1 FROM zvd_collections c WHERE 'zvd_' || c.name = p.tablename)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t.tablename);
    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format('ALTER TABLE public.%I DROP COLUMN IF EXISTS tenant_id', t.tablename);
  END LOOP;
END
$$;
