-- 116_rules_need_their_object.sql
--
-- ADR 0002 step 5: a rule names an object that exists.
--
-- Collections and every other Casbin object share the policy's object column.
-- While extensions could invent object names (v1 manifest `resources`), a rule
-- on a name no collection carried was legal, and the engine guessed which rules
-- were a collection's (`since`, `keepGrants`, `nonCollectionObjects`,
-- `adopt_rules`). The migration wave left every first-party extension on
-- collections and actions, so the database now holds the rule itself: a `p`
-- rule, and a revoked default, name
--
--   `*`                        every object
--   `admin`, `data`, `$edge`   the engine's objects (ENGINE_CASBIN_OBJECTS, EDGE_SCOPE)
--   `$ext:<name>`              a registered extension's own object; its purge
--                              deletes these rules (deleteExtensionObjectRules)
--   a collection               a row of `zvd_collections`; its drop deletes
--                              these rules (DDLManager.dropInTransaction)
--
-- and nothing else. A role link (`g`) names a domain in v2, not an object.
-- `zveltio_rule_object_exists` is also what a schema plan asks before it
-- grants or records a revocation (schema-artifact/apply.ts).
--
-- Rules already on no such object — a retired zone's, a v1 extension
-- resource's, a purged extension's, a dropped collection's that the old drop
-- kept — grant nothing anyone asks for. They move to the `_pruned_116` tables,
-- as 012/033/034 keep theirs, so the deletion is reversible and auditable.
--
-- Re-runnable.

CREATE OR REPLACE FUNCTION public.zveltio_rule_object_exists(obj text) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT obj IN ('*', 'admin', 'data', '$edge')
      OR EXISTS (SELECT 1 FROM public.zvd_collections WHERE name = obj)
      OR (starts_with(obj, '$ext:')
          AND EXISTS (SELECT 1 FROM public.zv_extension_registry WHERE name = substr(obj, 6)))
$$;

CREATE OR REPLACE FUNCTION public.zveltio_refuse_rule_without_object() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  obj text;
BEGIN
  IF TG_TABLE_NAME = 'zvd_permissions' THEN
    IF NEW.ptype IS DISTINCT FROM 'p' THEN
      RETURN NEW;
    END IF;
    obj := NEW.v2;
  ELSE
    obj := NEW.resource;
  END IF;
  IF public.zveltio_rule_object_exists(obj) IS NOT TRUE THEN
    RAISE EXCEPTION 'A rule names "%", which is not *, an engine object, a registered extension or an existing collection', obj
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS zvd_permissions_pruned_116 (
  id          uuid PRIMARY KEY,
  ptype       text NOT NULL,
  v0          text,
  v1          text,
  v2          text,
  v3          text,
  v4          text,
  v5          text,
  created_at  timestamptz,
  pruned_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE zvd_permissions_pruned_116 IS
  'Rules on an object that is not *, an engine object, a registered extension or '
  'an existing collection, removed by migration 116. Kept so the deletion is '
  'reversible and auditable; safe to drop once reviewed.';

CREATE TABLE IF NOT EXISTS zv_default_grant_revocations_pruned_116 (
  role        text NOT NULL,
  resource    text NOT NULL,
  action      text NOT NULL,
  revoked_at  timestamptz,
  pruned_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role, resource, action)
);

COMMENT ON TABLE zv_default_grant_revocations_pruned_116 IS
  'Revoked defaults on an object that is not *, an engine object, a registered '
  'extension or an existing collection, removed by migration 116. Kept so the '
  'deletion is reversible and auditable; safe to drop once reviewed.';

WITH stale AS (
  SELECT * FROM zvd_permissions
   WHERE ptype = 'p' AND zveltio_rule_object_exists(v2) IS NOT TRUE
), saved AS (
  INSERT INTO zvd_permissions_pruned_116 (id, ptype, v0, v1, v2, v3, v4, v5, created_at)
  SELECT id, ptype, v0, v1, v2, v3, v4, v5, created_at FROM stale
  ON CONFLICT (id) DO NOTHING
  RETURNING id
)
DELETE FROM zvd_permissions d
 USING saved s
 WHERE d.id = s.id;

WITH stale AS (
  SELECT * FROM zv_default_grant_revocations
   WHERE zveltio_rule_object_exists(resource) IS NOT TRUE
), saved AS (
  INSERT INTO zv_default_grant_revocations_pruned_116 (role, resource, action, revoked_at)
  SELECT role, resource, action, revoked_at FROM stale
  ON CONFLICT DO NOTHING
  RETURNING role, resource, action
)
DELETE FROM zv_default_grant_revocations d
 USING saved s
 WHERE (d.role, d.resource, d.action) = (s.role, s.resource, s.action);

DROP TRIGGER IF EXISTS zv_rule_needs_object ON zvd_permissions;
CREATE TRIGGER zv_rule_needs_object
  BEFORE INSERT OR UPDATE OF ptype, v2 ON zvd_permissions
  FOR EACH ROW EXECUTE FUNCTION zveltio_refuse_rule_without_object();

DROP TRIGGER IF EXISTS zv_rule_needs_object ON zv_default_grant_revocations;
CREATE TRIGGER zv_rule_needs_object
  BEFORE INSERT OR UPDATE OF resource ON zv_default_grant_revocations
  FOR EACH ROW EXECUTE FUNCTION zveltio_refuse_rule_without_object();

-- DOWN
DROP TRIGGER IF EXISTS zv_rule_needs_object ON zv_default_grant_revocations;
DROP TRIGGER IF EXISTS zv_rule_needs_object ON zvd_permissions;
DROP FUNCTION IF EXISTS zveltio_refuse_rule_without_object();
DROP FUNCTION IF EXISTS zveltio_rule_object_exists(text);
INSERT INTO zvd_permissions (id, ptype, v0, v1, v2, v3, v4, v5, created_at)
SELECT id, ptype, v0, v1, v2, v3, v4, v5, created_at FROM zvd_permissions_pruned_116
ON CONFLICT DO NOTHING;
INSERT INTO zv_default_grant_revocations (role, resource, action, revoked_at)
SELECT role, resource, action, revoked_at FROM zv_default_grant_revocations_pruned_116
ON CONFLICT DO NOTHING;
DROP TABLE IF EXISTS zv_default_grant_revocations_pruned_116;
DROP TABLE IF EXISTS zvd_permissions_pruned_116;
