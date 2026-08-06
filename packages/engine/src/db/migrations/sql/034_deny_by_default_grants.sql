-- Deny by default: replace the partial wildcards with the rows they stood for.
--
-- Migration 009 seeded the tenant roles as `('tenant_member', '*', '*', 'read')`
-- and the same for create and update. The enforcer now honours `*` on the object
-- only when the grant is total (`act = '*'`), so those four rows grant nothing —
-- and the twenty-three extensions that guard routes with
-- `permissionGate(ctx, '<resource>')` finally get an answer that depends on the
-- resource name. Before this, they did not: an ordinary member could read and
-- edit a colleague's national ID, IBAN, salary and home address.
--
-- The point of this migration is that the change is not supposed to be felt
-- anywhere else. Every resource that existed before gets written out
-- explicitly, so an operator upgrading keeps exactly the access they had, minus
-- the four resources listed as sensitive, which is the whole intent.
--
-- `tenant_owner` and `tenant_admin` are untouched. Their grant is `('*','*','*')`
-- — total, still matches everything, and has to: locking administrators out of
-- HR would not be confidentiality, it would be an outage.
--
-- Two namespaces have to be covered and only one is queryable. Collections live
-- in `zvd_collections`. Extension resources exist only as string literals in
-- extension source, so they are listed below; from here on an extension declares
-- them in its manifest and `scripts/check-extension-resources.ts` fails the build
-- on an undeclared one. A fresh install runs this with `zvd_collections` still
-- empty, which is correct — `materializeDefaultGrants` runs on every collection
-- creation and again at boot, so nothing depends on this migration having seen
-- the full picture.

-- Resources that stay closed until a role is granted them by name. Kept in step
-- with SENSITIVE_RESOURCES in lib/tenancy/permissions.ts.
CREATE TEMP TABLE _sensitive (name TEXT PRIMARY KEY) ON COMMIT DROP;
INSERT INTO _sensitive (name) VALUES
  ('employees'), ('payroll'), ('leave'), ('banking');

CREATE TEMP TABLE _resources (name TEXT PRIMARY KEY) ON COMMIT DROP;

-- Collections, as they stand at upgrade time.
INSERT INTO _resources (name)
  SELECT name FROM zvd_collections
  ON CONFLICT DO NOTHING;

-- Extension resources: every distinct name passed to permissionGate() across the
-- 57 extensions when this landed. None of these is a collection — the two
-- namespaces are disjoint, so walking only zvd_collections would have closed all
-- twenty-eight of them.
INSERT INTO _resources (name) VALUES
  ('accounting'), ('api-connector'), ('assets'), ('banking'), ('checklists'),
  ('crm'), ('efactura'), ('employees'), ('etransport'), ('expenses'),
  ('export'), ('helpdesk'), ('import'), ('inventory'), ('invoices'),
  ('leave'), ('media'), ('payroll'), ('pos'), ('postgis'),
  ('procurement'), ('projects'), ('quotes'), ('ro-documents'), ('saft'),
  ('store'), ('subscriptions'), ('time-tracking')
  ON CONFLICT DO NOTHING;

-- Write out what the wildcards granted, resource by resource.
INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3)
  SELECT 'p', roles.role, '*', r.name, roles.action
  FROM _resources r
  CROSS JOIN (VALUES
    ('tenant_member', 'read'),
    ('tenant_member', 'create'),
    ('tenant_member', 'update'),
    ('tenant_viewer', 'read')
  ) AS roles(role, action)
  WHERE r.name NOT IN (SELECT name FROM _sensitive)
ON CONFLICT DO NOTHING;

-- And drop the wildcards themselves. They are inert under the new matcher; the
-- reason to remove them is that a policy table an operator reads should say what
-- it means. Scoped to these two roles and to a named action, so an
-- administrator's total grant is never touched.
DELETE FROM zvd_permissions
 WHERE ptype = 'p'
   AND v0 IN ('tenant_member', 'tenant_viewer')
   AND v1 = '*'
   AND v2 = '*'
   AND v3 <> '*';
