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
-- Running engines: nothing is published. A replica that has not reloaded reads
-- a user's rows from the table while its model holds none for them, and the
-- reconcile tick brings the model to the table.

INSERT INTO zvd_permissions (ptype, v0, v1, v2)
SELECT 'g', u.id, 'member', '*'
  FROM "user" u
 WHERE u.role IS DISTINCT FROM 'god'
ON CONFLICT DO NOTHING;

-- DOWN

-- The previous release reads `member` from the column, so these rows are
-- redundant there; removing them restores 058's table, as 033 left it.
DELETE FROM zvd_permissions p
 USING "user" u
 WHERE p.ptype = 'g' AND p.v0 = u.id
   AND p.v1 = 'member' AND p.v2 = '*'
   AND p.v3 IS NULL AND p.v4 IS NULL AND p.v5 IS NULL;
