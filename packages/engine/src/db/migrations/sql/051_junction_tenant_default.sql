-- 051_junction_tenant_default.sql
--
-- The `tenant_id` 042 adds to m2m junctions gets the default every collection
-- table has: the writing transaction's tenant.
--
-- 042 added the column bare and left the default, like NOT NULL and the policy,
-- to the boot reconciler (`applyTenantRLS`). Until that ran, a link inserted
-- inside a tenant transaction — by a replica of the previous release during a
-- rolling upgrade, or by any replica after `zveltio migrate` was run ahead of
-- the new binary — got a NULL `tenant_id`, and the reconciler's backfill then
-- handed it to the default tenant: the link vanished from its own tenant and
-- appeared in the default one. Set here, in the same runner pass as 042, the
-- window is gone. Junctions created from now on get it from
-- `createJunctionTable` → `applyTenantRLS`, as before.
--
-- The expression is `applyTenantRLS`'s, so the reconciler finds nothing to
-- change. Catalogue-only, per junction; the runner's lock_timeout bounds the
-- wait for each lock.
--
-- Re-runnable: a junction whose tenant_id already has a default is skipped.

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'zvd\_jnc\_%'
       AND a.atttypid = 'uuid'::regtype AND NOT a.atthasdef
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN tenant_id SET DEFAULT '
      || 'COALESCE(NULLIF(current_setting(''zveltio.current_tenant'', true), '''')::uuid, '
      || '''00000000-0000-0000-0000-000000000001''::uuid)',
      t.relname);
  END LOOP;
END
$$;

-- DOWN

-- Not undone: the default is the one the boot reconciler sets on every junction
-- anyway, so removing it would only reopen the window until the next boot.
SELECT 1;
