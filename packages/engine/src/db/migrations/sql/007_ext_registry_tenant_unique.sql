-- Per-firm extension activation was unrepresentable, and one constraint is why.
--
-- `tenant_id` was added to zv_extension_registry with this comment:
--
--   tenant_id NULL  = global (available to all tenants / instance-wide)
--   tenant_id SET   = enabled only for that specific tenant
--
-- and a composite index built for `WHERE (tenant_id IS NULL OR tenant_id = $1)`.
-- The intent was there from the start. The table kept `name text UNIQUE` from
-- 001, so an extension had exactly ONE row and `tenant_id` could only record
-- who installed it last. A second firm's row was a duplicate key:
--
--   INSERT ai for firm A  → ok
--   INSERT ai for firm B  → ERROR: duplicate key ... Key (name)=(ai) exists
--
-- So the column recorded a decision that could never be made, and every reader
-- that honoured it — the marketplace listing did — reported a firm-scoped fact
-- from an instance-scoped row. The loader, which ignored `tenant_id` entirely,
-- had by accident the only correct behaviour in the file.
--
-- ── Why NULLS NOT DISTINCT ────────────────────────────────────
--
-- In a plain unique index NULL differs from itself, so `(tenant_id, name)`
-- alone would let an extension carry several conflicting instance-wide rows —
-- god installs, god installs again, and now two rows disagree about is_enabled
-- with nothing to say which wins. NULLS NOT DISTINCT (Postgres 15+) treats the
-- global row as the single row it is meant to be.
--
-- ── Upgrade path ──────────────────────────────────────────────
--
-- Rows written before this migration have tenant_id IS NULL, so they become
-- the global row unchanged: what is active today stays active for every firm.
-- Nothing is backfilled and no firm-scoped row is invented.

ALTER TABLE zv_extension_registry
  DROP CONSTRAINT IF EXISTS zv_extension_registry_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS ux_zv_ext_registry_tenant_name
  ON zv_extension_registry (tenant_id, name) NULLS NOT DISTINCT;
