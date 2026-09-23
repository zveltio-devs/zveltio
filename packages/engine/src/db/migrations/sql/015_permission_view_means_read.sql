-- 015_permission_view_means_read.sql
--
-- The permissions screen granted `view`; the engine asks for `read`.
--
-- `GET /api/admin/resources` offered every collection the actions
-- `view, create, update, delete`, and the screen stores whatever it is offered
-- (`POST /api/admin/permissions/bulk` -> one `p` row per tick, action in `v3`).
-- The data handlers ask Casbin for `read`, and the matcher compares actions
-- exactly. So every "view" ticked on that screen granted nothing: members of the
-- role were refused 403 on a collection the screen showed as readable.
--
-- No Casbin check anywhere in the engine asks for `view` (the `'view'` in the
-- data handlers is the entity-access registry, a different mechanism), so a `p`
-- row with `v3 = 'view'` has never done anything. Rewriting it to `read` gives
-- it the meaning the administrator ticked. Rows that already have the `read`
-- twin are dropped instead of duplicated.

DELETE FROM zvd_permissions v
 WHERE v.ptype = 'p'
   AND v.v3 = 'view'
   AND EXISTS (
     SELECT 1 FROM zvd_permissions r
      WHERE r.ptype = 'p'
        AND r.v0 IS NOT DISTINCT FROM v.v0
        AND r.v1 IS NOT DISTINCT FROM v.v1
        AND r.v2 IS NOT DISTINCT FROM v.v2
        AND r.v3 = 'read'
   );

UPDATE zvd_permissions SET v3 = 'read' WHERE ptype = 'p' AND v3 = 'view';

-- DOWN

-- Deliberately empty. The rows rewritten here never granted anything as `view`;
-- turning them back would revoke access administrators meant to give, and a
-- rollback that reintroduces the defect is not a rollback.
