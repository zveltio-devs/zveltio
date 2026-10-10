-- 060_tenant_write_reach.sql
--
-- A write lands only where the writer can read (owner decision 2026-10-10).
--
-- `zveltio_tenant_write_ok` (004) asked one thing: is the row's unit the
-- current unit? It never asked whether the caller reaches that unit at all. A
-- member whose every assignment in the default tenant had lapsed resolves to
-- the impossible unit (`zveltio_tenant_reach`, 057), so every read answered
-- nothing — but the membership door admits everyone to the default tenant, and
-- an INSERT that read nothing back (an extension's plain `ctx.db` insert, any
-- write without RETURNING) passed WITH CHECK and landed. UPDATE and DELETE were
-- already refused, by USING: a row the caller cannot read is a row they cannot
-- touch.
--
-- Now the write half carries the reach's verdict too: the row's unit must be
-- the current unit, and the reach must not be the impossible unit. A parent
-- with `subtree` reach still cannot write into a child: the first condition
-- still binds.
--
-- WHY THE SENTINEL AND NOT `row_tenant = ANY (zveltio_visible_tenants())`.
-- The two agree for every publisher of the set: the reach always contains the
-- own unit unless it is NO_UNITS (057), god and the all-firms readers publish
-- every firm, and with no set published the read fallbacks are the three
-- branches below. They do not cost the same. WITH CHECK runs per written row
-- and the set cannot be hoisted out of it (a subquery stops the inlining), so
-- `= ANY` re-parsed the whole set for every row. Measured, 100 000 inserts:
--
--                          single unit     500-firm set (god, org reach)
--   004 (no reach)            143 ms            146 ms
--   = ANY (set)               220 ms         18 713 ms
--   sentinel (this)           147 ms            232 ms
--
-- The ceiling, should a publisher ever publish a set that leaves out the current
-- unit: a row could still be INSERTed there, as before this migration. Its
-- UPDATE and DELETE stay refused by USING.
--
-- PARALLEL SAFE restated on purpose: CREATE OR REPLACE resets what it does not
-- restate (see 003/004). Re-runnable.

CREATE OR REPLACE FUNCTION zveltio_tenant_write_ok(row_tenant uuid)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN NULLIF(current_setting('zveltio.current_tenant', true), '') IS NOT NULL THEN
      row_tenant = NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid
    WHEN lower(coalesce(nullif(current_setting('zveltio.fail_closed_tenant', true), ''), 'off'))
         IN ('on', 'true', '1') THEN
      false
    ELSE
      row_tenant = '00000000-0000-0000-0000-000000000001'::uuid
  END
  AND NULLIF(current_setting('zveltio.visible_tenants', true), '')
      IS DISTINCT FROM '00000000-0000-0000-0000-000000000000'
$$;

CREATE OR REPLACE FUNCTION zveltio_tenant_write_ok(row_tenant text)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN NULLIF(current_setting('zveltio.current_tenant', true), '') IS NOT NULL THEN
      row_tenant = NULLIF(current_setting('zveltio.current_tenant', true), '')
    WHEN lower(coalesce(nullif(current_setting('zveltio.fail_closed_tenant', true), ''), 'off'))
         IN ('on', 'true', '1') THEN
      false
    ELSE
      row_tenant = '00000000-0000-0000-0000-000000000001'
  END
  AND NULLIF(current_setting('zveltio.visible_tenants', true), '')
      IS DISTINCT FROM '00000000-0000-0000-0000-000000000000'
$$;

-- DOWN

CREATE OR REPLACE FUNCTION zveltio_tenant_write_ok(row_tenant uuid)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN NULLIF(current_setting('zveltio.current_tenant', true), '') IS NOT NULL THEN
      row_tenant = NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid
    WHEN lower(coalesce(nullif(current_setting('zveltio.fail_closed_tenant', true), ''), 'off'))
         IN ('on', 'true', '1') THEN
      false
    ELSE
      row_tenant = '00000000-0000-0000-0000-000000000001'::uuid
  END
$$;

CREATE OR REPLACE FUNCTION zveltio_tenant_write_ok(row_tenant text)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN NULLIF(current_setting('zveltio.current_tenant', true), '') IS NOT NULL THEN
      row_tenant = NULLIF(current_setting('zveltio.current_tenant', true), '')
    WHEN lower(coalesce(nullif(current_setting('zveltio.fail_closed_tenant', true), ''), 'off'))
         IN ('on', 'true', '1') THEN
      false
    ELSE
      row_tenant = '00000000-0000-0000-0000-000000000001'
  END
$$;
