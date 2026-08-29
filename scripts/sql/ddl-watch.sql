-- Log EVERY DDL command, whatever issued it.
--
-- `log_statement='ddl'` logs top-level CREATE/ALTER/DROP and nothing else: DDL
-- issued from inside a `DO $$ ... EXECUTE ... $$` block never appears, and the
-- engine has exactly such a block — `applyTenantRLS` (tenant-manager.ts:198)
-- builds an index that way.
--
-- That matters for the intermittent `0A000 cached plan must not change result
-- type` on `select * from "zvd_collections" where "name" = $1`. Under the
-- statement log alone, a failing run showed NO post-boot DDL on that table at
-- all — which is either the answer or a blind spot, and the two look identical
-- from outside. An event trigger fires on `ddl_command_end` for every command
-- regardless of who issued it, so DO blocks, function bodies and plain
-- statements all land in the same container log the workflow already prints.
--
-- Diagnostic only. Installed by CI into the throwaway test database; nothing
-- ships with it.
CREATE OR REPLACE FUNCTION zz_log_ddl() RETURNS event_trigger
LANGUAGE plpgsql AS $fn$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
    RAISE LOG 'ZZDDL pid=% tag=% object=%', pg_backend_pid(), r.command_tag, r.object_identity;
  END LOOP;
END
$fn$;

DROP EVENT TRIGGER IF EXISTS zz_ddl_watch;
CREATE EVENT TRIGGER zz_ddl_watch ON ddl_command_end EXECUTE FUNCTION zz_log_ddl();
