-- 055_schema_migrations.sql
--
-- The schema-as-code migrations an instance has run (docs/engine/rfc-schema-as-code.md
-- §4.4). `zveltio schema apply` sends `schema/migrations/<id>.json` with the
-- state files; each one runs once, and its checksum is kept so that a file
-- edited after it ran is refused instead of silently skipped.
--
-- Not tenant data: the schema these migrations change (collections, global
-- roles) is shared by every tenant of the instance. Written only by
-- `lib/schema-artifact/apply.ts`, behind the god-only `/api/admin/schema/apply`.
-- `applied_by` is a user id kept as text, not a foreign key: the record of what
-- ran outlives the account that ran it.
--
-- Re-runnable.

CREATE TABLE IF NOT EXISTS zv_schema_migrations (
  id         text PRIMARY KEY,
  checksum   text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by text
);

-- DOWN

DROP TABLE IF EXISTS zv_schema_migrations;
