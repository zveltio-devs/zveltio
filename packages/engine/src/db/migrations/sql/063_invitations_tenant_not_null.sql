-- 063_invitations_tenant_not_null.sql
--
-- An invitation always names its tenant.
--
-- `zv_invitations.tenant_id` was added nullable (old 021) with a default that
-- falls back to the default tenant, so the engine never stores NULL — but the
-- column allowed it, and accepting such an invitation inserted a NULL tenant
-- into `zv_tenant_users` AFTER `signUpEmail` had created the account outside
-- that transaction: a 500, an account with no membership, and the invitation
-- still unconsumed. Now the database refuses the row instead.
--
-- A NULL row can only come from a write outside the engine. It joins the
-- default tenant, which is what the column's own default and old 021's
-- backfill decided for an invitation that names none.
--
-- squawk's adding-not-nullable-field: SET NOT NULL scans the table under
-- ACCESS EXCLUSIVE. Here that is one row per invitation ever sent, read only
-- by the two /api/invitations routes, never per request; the wait for the lock
-- is bounded by the runner's lock_timeout. Its CHECK ... NOT VALID workaround
-- buys nothing inside the runner's one transaction (squawk's own
-- constraint-missing-not-valid says so). Ignored for this file only.

-- squawk-ignore-file adding-not-nullable-field

-- Re-runnable.

DO $$
DECLARE
  n int;
BEGIN
  UPDATE zv_invitations
     SET tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
   WHERE tenant_id IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE NOTICE '063: % invitation(s) without a tenant now belong to the default tenant', n;
  END IF;
END $$;

ALTER TABLE zv_invitations ALTER COLUMN tenant_id SET NOT NULL;

-- DOWN

ALTER TABLE zv_invitations ALTER COLUMN tenant_id DROP NOT NULL;
