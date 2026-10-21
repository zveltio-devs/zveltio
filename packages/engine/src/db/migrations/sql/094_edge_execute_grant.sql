-- 094_edge_execute_grant.sql
--
-- `/api/fn/:name` now asks Casbin for `execute` on `$edge` before it runs a
-- non-public function (routes/edge-functions.ts); until now signing in was
-- enough. This is the access ordinary tenant members had, written down, so an
-- upgrade does not take it from them: the same `tenant_member` `execute` an
-- extension resource gets by default. Viewers do not get it (running code is
-- not reading), nor does the bare `member` role, which holds no default grant
-- on anything. God and tenant admins pass through their total grants.
--
-- Revocable like any default grant (zv_default_grant_revocations, 086), and
-- re-runnable.

INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3)
SELECT 'p', 'tenant_member', '*', '$edge', 'execute'
 WHERE NOT EXISTS (SELECT 1 FROM zv_default_grant_revocations
                    WHERE role = 'tenant_member' AND resource = '$edge' AND action = 'execute')
ON CONFLICT DO NOTHING;

-- DOWN
DELETE FROM zvd_permissions
 WHERE ptype = 'p' AND v0 = 'tenant_member' AND v1 = '*' AND v2 = '$edge' AND v3 = 'execute';
