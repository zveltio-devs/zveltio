-- 059_member_role_in_casbin.sql
--
-- `member` becomes a Casbin role: one `g <user> member *` row per account that
-- is not god (owner decision 2026-10-07 — Casbin is the one source of roles).
--
-- Until now `"user".role` was read as a role in every domain (033 removed the
-- `g` mirror). The engine no longer reads it as one: `god` stays there as an
-- instance attribute (the god bypass), and `member` is written to Casbin by
-- every path that creates an account (sign-up hook, identity provisioning) or
-- demotes a god (PATCH /api/users/:id, recovery). This backfills the accounts
-- that exist. Without it every existing member would lose `member` the moment
-- the column stopped counting — and with it every grant to `member` and every
-- column or row rule that restricts members.
--
-- '*' domain: the column role held in every domain, and so does this row. Gods
-- get none — the bypass gives them everything, and a demotion writes the row.
-- Re-runnable: the unique index on zvd_permissions makes a held row a no-op.
-- Nothing else is removed.
--
-- From here on a trigger writes the row, in the transaction that creates or
-- demotes the account — not the application after it. better-auth runs its
-- `create.after` hook once its sign-up transaction has COMMITTED, so a grant
-- that failed there left a committed account and password with no row; and an
-- account written by anything else (a 058 replica during a rolling upgrade, a
-- demotion the route's grant failed after, raw SQL) got none at all. An
-- account without `member` is out from under every rule that restricts members.
-- The application still grants through the enforcer — that keeps the live
-- models warm; the adapter treats the row the trigger already wrote as held.
-- SECURITY INVOKER, as 017's trigger on the same table: every role that writes
-- "user" holds DML on zvd_permissions.
--
-- Running engines: nothing is published. A replica that has not reloaded reads
-- a user's rows from the table while its model holds none for them, and the
-- reconcile tick brings the model to the table.

CREATE OR REPLACE FUNCTION zveltio_grant_member_role() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.zvd_permissions (ptype, v0, v1, v2)
  VALUES ('g', NEW.id, 'member', '*')
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS zv_grant_member_role ON "user";
CREATE TRIGGER zv_grant_member_role
  AFTER INSERT ON "user"
  FOR EACH ROW WHEN (NEW.role IS DISTINCT FROM 'god')
  EXECUTE FUNCTION zveltio_grant_member_role();

DROP TRIGGER IF EXISTS zv_grant_member_role_on_demotion ON "user";
CREATE TRIGGER zv_grant_member_role_on_demotion
  AFTER UPDATE OF role ON "user"
  FOR EACH ROW WHEN (OLD.role = 'god' AND NEW.role IS DISTINCT FROM 'god')
  EXECUTE FUNCTION zveltio_grant_member_role();

-- After the triggers, not before: an account a running replica commits between
-- a backfill and the CREATE TRIGGER would be in neither.
INSERT INTO zvd_permissions (ptype, v0, v1, v2)
SELECT 'g', u.id, 'member', '*'
  FROM "user" u
 WHERE u.role IS DISTINCT FROM 'god'
ON CONFLICT DO NOTHING;

-- DOWN

DROP TRIGGER IF EXISTS zv_grant_member_role_on_demotion ON "user";
DROP TRIGGER IF EXISTS zv_grant_member_role ON "user";
DROP FUNCTION IF EXISTS zveltio_grant_member_role();

-- The previous release reads `member` from the column, so these rows are
-- redundant there; removing them restores 058's table, as 033 left it.
DELETE FROM zvd_permissions p
 USING "user" u
 WHERE p.ptype = 'g' AND p.v0 = u.id
   AND p.v1 = 'member' AND p.v2 = '*'
   AND p.v3 IS NULL AND p.v4 IS NULL AND p.v5 IS NULL;
