-- 133_identity_links_every_tenant.sql
--
-- 120 carried `auth/scim`'s provisioning state (`zvd_scim_users`) over into
-- `zv_identity_links` with no tenant set. `zvd_scim_users` is a collection
-- table: FORCE ROW LEVEL SECURITY, rows visible by `zveltio_visible_tenants()`.
-- On the documented install the migrations run as a NOSUPERUSER NOBYPASSRLS
-- owner, which that policy binds, so the copy read the default tenant's rows
-- only (before 123), or none (with ZVELTIO_FAIL_CLOSED_TENANT=1). Every other
-- tenant's SCIM provider lost its reach over the accounts it provisioned.
-- A superuser connection bypassed RLS and copied all of them; this then adds
-- nothing.
--
-- The same copy, one tenant at a time with that tenant set for this
-- transaction (`set_config(…, true)`), so the policies on both tables admit
-- its rows, the links' WITH CHECK included (134). A link already there is kept
-- (ON CONFLICT DO NOTHING). An install whose `zvd_scim_users` is gone has
-- nothing left to recover. Re-runnable.

DO $$
DECLARE
  t record;
BEGIN
  IF to_regclass('public.zvd_scim_users') IS NOT NULL THEN
    FOR t IN SELECT id FROM zv_tenants LOOP
      PERFORM set_config('zveltio.current_tenant', t.id::text, true);
      INSERT INTO zv_identity_links (tenant_id, provider, subject, user_id, active,
                                     suspended_at, held_valid_to)
      SELECT s.tenant_id, 'auth/scim', s.user_id, s.user_id, COALESCE(s.active, true),
             s.suspended_at, s.held_valid_to
        FROM zvd_scim_users s
        JOIN "user" u ON u.id = s.user_id
       WHERE s.tenant_id = t.id
      ON CONFLICT DO NOTHING;
    END LOOP;
    PERFORM set_config('zveltio.current_tenant', '', true);
  END IF;
END
$$;

-- DOWN

-- Not reversed: the links it adds are the ones 120 meant to add.
SELECT 1;
