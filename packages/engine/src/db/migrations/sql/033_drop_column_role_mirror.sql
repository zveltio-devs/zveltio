-- 033_drop_column_role_mirror.sql
--
-- The `g <user> god|member *` rows, removed: `"user".role` is now the only
-- source of god/member.
--
-- `PATCH /api/users/:id` copied the column into Casbin as `g <user> <role> *`
-- (and wiped every other global role to do it). `checkPermission` now reads the
-- column itself as a subject in every domain, so the copies are redundant at
-- best and stale at worst: the recovery flow demotes a god in the column only,
-- and a demoted god kept `g <user> god *` — and with it any `p god …` grant an
-- operator had written (`POST /api/permissions/policies` accepts one) — while
-- the god bypass itself was gone. Nothing seeds a `p god` rule; `p member` is
-- seeded once, for the literal object `zvd_*`.
--
-- Only rows whose subject is a real user: `g member member *` (seeded) and any
-- other role→role edge has a role in v0, never a user id. Only the '*' domain,
-- the one the mirror wrote. Only the three-value `g` shape.
--
-- Deleted rows are copied to `zvd_permissions_pruned_033` first, as 012 does:
-- a DELETE of authorization rows stays reversible by someone who did not run it,
-- and a `god` row whose user's column says `member` is the record that a
-- demoted god held one.
--
-- Running engines: nothing is published. The reconcile tick compares the
-- table's fingerprint with what each instance loaded and rebuilds the enforcer.

CREATE TABLE IF NOT EXISTS zvd_permissions_pruned_033 (
  id          uuid PRIMARY KEY,
  ptype       text NOT NULL,
  v0          text,
  v1          text,
  v2          text,
  v3          text,
  v4          text,
  v5          text,
  created_at  timestamptz,
  column_role text,          -- "user".role when the row was pruned
  pruned_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE zvd_permissions_pruned_033 IS
  'Casbin g rows that mirrored "user".role, removed by migration 033 once the '
  'column became the only source. Kept so the deletion is reversible and '
  'auditable; safe to drop once reviewed.';

WITH mirror AS (
  SELECT p.*, u.role AS column_role
    FROM zvd_permissions p
    JOIN "user" u ON u.id = p.v0
   WHERE p.ptype = 'g'
     AND p.v1 IN ('god', 'member')
     AND p.v2 = '*'
     AND p.v3 IS NULL AND p.v4 IS NULL AND p.v5 IS NULL
), saved AS (
  INSERT INTO zvd_permissions_pruned_033
    (id, ptype, v0, v1, v2, v3, v4, v5, created_at, column_role)
  SELECT id, ptype, v0, v1, v2, v3, v4, v5, created_at, column_role FROM mirror
  ON CONFLICT (id) DO NOTHING
  RETURNING id
)
DELETE FROM zvd_permissions d
 USING saved s
 WHERE d.id = s.id;

-- DOWN
INSERT INTO zvd_permissions (id, ptype, v0, v1, v2, v3, v4, v5, created_at)
SELECT id, ptype, v0, v1, v2, v3, v4, v5, created_at
  FROM zvd_permissions_pruned_033
ON CONFLICT DO NOTHING;

DROP TABLE IF EXISTS zvd_permissions_pruned_033;
