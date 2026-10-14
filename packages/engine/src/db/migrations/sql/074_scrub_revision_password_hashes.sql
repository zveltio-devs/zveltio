-- 074_scrub_revision_password_hashes.sql
--
-- Revisions written before 073 still carry password hashes (L37, layer 2).
--
-- 073 seals a `password` column from every request role, and since then
-- `afterWrite` strips unserved fields from a revision's `data` and `delta`. The
-- revisions written before it kept the hash, and `zv_revisions` is readable by
-- `zveltio_rls`: on an existing install "no request role can read a password
-- hash" stayed false until this runs. A revert never restores a password
-- (the field serializes to nothing), so the copies are history no one may use.
--
-- Only the core `password` type is known here. A password-like type an
-- extension registers is stripped from new revisions by the engine, not from
-- old ones by this migration.
--
-- `zv_revisions` is FORCE RLS on `zveltio_visible_tenants()`, so every tenant is
-- made visible for reading, and each tenant's rows are rewritten as that tenant
-- (the RESTRICTIVE own-node UPDATE policy filters any other row out in
-- silence), as 061 does. Re-runnable: a scrubbed row no longer matches.

DO $$
DECLARE
  t uuid;
BEGIN
  PERFORM set_config(
    'zveltio.visible_tenants',
    coalesce((SELECT string_agg(id::text, ',') FROM zv_tenants), ''),
    true);

  CREATE TEMP TABLE zv_074_password_fields ON COMMIT DROP AS
    SELECT c.name, array_agg(f->>'name') AS cols
      FROM zvd_collections c,
           jsonb_array_elements(CASE WHEN jsonb_typeof(c.fields) = 'array'
                                     THEN c.fields ELSE '[]'::jsonb END) f
     WHERE f->>'type' = 'password' AND f->>'name' IS NOT NULL
     GROUP BY c.name;

  FOR t IN
    SELECT DISTINCT r.tenant_id
      FROM zv_revisions r JOIN zv_074_password_fields p ON r.collection = p.name
     WHERE r.data ?| p.cols OR coalesce(r.delta ?| p.cols, false)
  LOOP
    PERFORM set_config('zveltio.current_tenant', t::text, true);
    UPDATE zv_revisions r
       SET data = r.data - p.cols,
           delta = CASE WHEN r.delta IS NULL THEN NULL ELSE r.delta - p.cols END
      FROM zv_074_password_fields p
     WHERE r.collection = p.name
       AND r.tenant_id = t
       AND (r.data ?| p.cols OR coalesce(r.delta ?| p.cols, false));
  END LOOP;

  DROP TABLE zv_074_password_fields;
  PERFORM set_config('zveltio.current_tenant', '', true);
  PERFORM set_config('zveltio.visible_tenants', '', true);
END $$;

-- DOWN
-- Nothing to undo: the removed hashes are not recoverable, and putting them
-- back is exactly what this migration exists to prevent.
SELECT 1;
