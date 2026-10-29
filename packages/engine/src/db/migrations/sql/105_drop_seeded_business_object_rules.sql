-- 105_drop_seeded_business_object_rules.sql
--
-- Migration 001 granted the seeded roles (employee, manager, client,
-- tenant_member, tenant_viewer, member) on 33 names of v1 extension resources
-- that were never collections: `projects`, `invoices`, `crm`… Under ADR 0002 a
-- bare Casbin object is a collection, and the engine's own objects are `admin`,
-- `data`, `$edge` and `*`. An extension that declares a collection under one of
-- those names (ADR 0012; the `projects/management` pilot declares `projects`)
-- was refused: the rules already there would have taken effect on it
-- (`existing_rules`). The rules go, in every domain, unless a collection of that
-- name exists. An installed v1 extension that still declares one of them as a
-- `resource` gets its default grants back from the boot reconcile until the
-- wave moves it to collections.

DELETE FROM zvd_permissions
 WHERE ptype = 'p'
   AND v2 IN (
     'api-connector', 'approvals', 'assets', 'checklists', 'crm', 'document-templates',
     'documents', 'efactura', 'etransport', 'expenses', 'export', 'forms', 'helpdesk',
     'import', 'intranet', 'inventory', 'invoices', 'leave', 'media', 'portal', 'pos',
     'postgis', 'procurement', 'projects', 'quotes', 'ro-documents', 'saft', 'search',
     'store', 'subscriptions', 'time-tracking', 'translations', 'zvd_*'
   )
   AND v2 NOT IN (SELECT name FROM zvd_collections);

-- DOWN

-- Deliberately empty: a rule on one of these names is the defect. The default
-- grants of a name an installed extension still declares come back at boot.
SELECT 1;
