-- Casbin RBAC-with-domains (beta.19). Reshape existing policies into the
-- 4-token form, placing every pre-existing policy/grant in domain '*' (applies
-- in EVERY tenant) so authorization is byte-for-byte unchanged. Per-tenant
-- policies use a concrete tenant id and are purely additive.
--
-- zvd_permissions is a GLOBAL infra table (Casbin policy store), not per-tenant
-- data — it is intentionally NOT row-level-security'd.
--
-- Layout change:
--   p (policy):  v0=sub, v1=obj, v2=act          →  v0=sub, v1=dom, v2=obj, v3=act
--   g (grant):   v0=user, v1=role                →  v0=user, v1=role, v2=dom
--
-- Postgres evaluates the SET right-hand sides against the pre-UPDATE row, so the
-- shift below is correct. The `v3 IS NULL` / `v2 IS NULL` guards make it
-- idempotent (a row already in 4-token form is skipped).

UPDATE zvd_permissions
   SET v3 = v2, v2 = v1, v1 = '*'
 WHERE ptype = 'p' AND v3 IS NULL;

UPDATE zvd_permissions
   SET v2 = '*'
 WHERE ptype = 'g' AND v2 IS NULL;
