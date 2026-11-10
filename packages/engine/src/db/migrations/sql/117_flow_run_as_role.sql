-- 117_flow_run_as_role.sql
--
-- A flow, a webhook and a data trigger run under a role chosen when they are
-- saved (ADR 0004).
--
-- A flow step ran in its firm with no actor, so the masking views (095) and the
-- row-rule policies stood down for it: `export_collection` returned the columns
-- a column rule hides, a webhook delivery and a data trigger's `trigger_data`
-- carried the record as stored. `run_as_role` is the Casbin role each reads as
-- (`rolePrincipal`); the routes refuse a role the saver does not hold.
--
-- Existing rows take `tenant_member`, the tenant's member role (ADR 0004,
-- Consequences): what any member of the firm may read, never more than the
-- tenant admin who wrote them. A row written without the column takes it too.
-- NULL is a role that was deleted (`deleteRole`): such a flow does not run and
-- such a webhook does not deliver until it is saved with a role again. No CHECK on the name: a role is a Casbin row, not a table row.
--
-- A column with a constant default fills the existing rows as DDL, so the
-- tenant policy on both tables (027, 028) cannot hide any firm's rows from it.

ALTER TABLE zv_flows ADD COLUMN IF NOT EXISTS run_as_role text DEFAULT 'tenant_member';
ALTER TABLE zvd_webhooks ADD COLUMN IF NOT EXISTS run_as_role text DEFAULT 'tenant_member';

-- DOWN

ALTER TABLE zvd_webhooks DROP COLUMN IF EXISTS run_as_role;
ALTER TABLE zv_flows DROP COLUMN IF EXISTS run_as_role;
