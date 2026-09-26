-- 017_prune_deleted_user_grants.sql
--
-- The Casbin rows of users deleted before #670, removed — and, by a trigger on
-- "user", never left behind again whoever deletes the row.
--
-- `DELETE /api/users/:id` deleted the user row and nothing in
-- `zvd_permissions`: no column there references "user", so every `g` row (a
-- role, in any domain) and `p` row whose subject was that id stayed. #670 made
-- the route call `enforcer.deleteUser`; the rows it had already left behind are
-- still loaded by every enforcer at boot, and `GET /admin/roles/hierarchy`,
-- which tells users from roles by "v0 is a user", lists each as a role edge.
-- They authorize nobody — better-auth ids are random and never reused — so
-- this is cleanup, not a security fix.
--
-- WHAT COUNTS AS EVIDENCE
--
-- A role name and a better-auth id are the same shape in `v0`, and the built-in
-- roles live only in Casbin, so "v0 is not a user" alone would delete every
-- role. The evidence is the audit row the route wrote: `user.deleted` with
-- `resource_id` = the id. It has no RLS and no tenant column, so the migration
-- sees all of it.
--
-- That row is not proof on its own. The route never checked that the id was a
-- user: `DELETE /api/users/editor` removed no row and still audited
-- `user.deleted` for `editor`. So a subject is pruned only when, besides the
-- audit row and the missing user row, nothing says it is a role:
--
--   - it is not registered in `zv_roles`;
--   - no `g` row names it as the role (`v1`) — a user is never one, and a role
--     with members or children always is;
--   - it is not one of the roles the engine seeds into Casbin only.
--
-- What that can still remove is a role with no members, no children and no
-- registration that someone once passed to the delete route: rows that grant no
-- principal anything.
--
-- COVERAGE CEILING
--
-- Only deletes that went through `DELETE /api/users/:id` after the route began
-- auditing them (9eb70eea, 2026-05-25), and whose audit row still exists:
-- `AUDIT_LOG_RETENTION_DAYS` (default 365, 0 = forever) purges older ones, so an
-- install that set it below the age of its oldest such delete keeps those
-- orphans. Users removed by SQL, by the SCIM extension or by the GDPR erasure
-- left no `user.deleted` row and are not touched.
--
-- AND NO NEW ONES
--
-- The route was one of three ways a user row goes: SCIM deprovisioning
-- (`auth/scim`) and GDPR erasure (`compliance/gdpr`) delete it with raw SQL and
-- never touch Casbin, and so does anyone at a psql prompt. Fixing each caller
-- leaves the next one broken, so the rule lives on the table: the trigger at
-- the end removes a deleted user's `g` and `p` rows in the same statement. The
-- route still calls `enforcer.deleteUser` first, which also updates the live
-- model at once; the trigger then finds nothing.
--
-- RUNNING ENGINES
--
-- Nothing is published, by this file or by the trigger: the reconcile tick
-- (`reconcilePolicies`, 30-60 s) compares the table's fingerprint with what each
-- instance loaded and rebuilds the enforcer when they differ. An engine that
-- migrates at boot loads the pruned table directly.

DELETE FROM zvd_permissions p
 WHERE p.ptype IN ('g', 'p')
   AND p.v0 IN (SELECT a.resource_id FROM zv_audit_log a
                 WHERE a.event_type = 'user.deleted' AND a.resource_type = 'user')
   AND NOT EXISTS (SELECT 1 FROM "user" u WHERE u.id = p.v0)
   AND NOT EXISTS (SELECT 1 FROM zv_roles r WHERE r.name = p.v0)
   AND NOT EXISTS (SELECT 1 FROM zvd_permissions g WHERE g.ptype = 'g' AND g.v1 = p.v0)
   AND p.v0 NOT IN ('admin', 'member', 'tenant_owner', 'tenant_admin', 'tenant_manager',
                    'tenant_member', 'tenant_viewer');

-- A row in "user" is the evidence here, so no role guard: its id is a user's.
--
-- SECURITY INVOKER (the default, as every other trigger here): the deleting
-- role needs DELETE on zvd_permissions, and each role that can delete from
-- "user" has it — the owner, and `zveltio_rls`, which holds DML on every public
-- table. A role without it gets its user delete refused rather than a silent
-- orphan. No SECURITY DEFINER, so the search_path is the caller's; the table is
-- schema-qualified anyway.
CREATE OR REPLACE FUNCTION zveltio_drop_deleted_user_grants() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.zvd_permissions WHERE ptype IN ('g', 'p') AND v0 = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS zv_drop_deleted_user_grants ON "user";
CREATE TRIGGER zv_drop_deleted_user_grants
  AFTER DELETE ON "user"
  FOR EACH ROW EXECUTE FUNCTION zveltio_drop_deleted_user_grants();

-- DOWN

-- The prune is deliberately not reversed. Every row it removed names a subject
-- that no longer exists and whose id is never issued again; putting them back
-- restores only the phantom role edges.
DROP TRIGGER IF EXISTS zv_drop_deleted_user_grants ON "user";
DROP FUNCTION IF EXISTS zveltio_drop_deleted_user_grants();
