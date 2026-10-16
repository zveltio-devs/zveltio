-- 084_scrub_stale_revision_password_hashes.sql
--
-- The password hashes 074 left in revisions, which `zveltio_rls` still reads.
--
-- 074 took the key of every CURRENT `password` field out of each revision's
-- `data` and `delta`, matched with `?|`. Two kinds of copy kept their hash, and
-- `zvv__revisions` (077) serves both to SQL on `zveltio_rls` (an insight query,
-- an RPC function), since it masks column rules, not field types. Measured on
-- 083, inside a tenant, after re-running 074:
--
--     SET LOCAL ROLE zveltio_rls;
--     SELECT data FROM zvv__revisions;
--       {"oldpw": "$argon2id$…", "title": "f"}   a password field renamed or
--                                                 dropped, or its collection
--                                                 dropped, before 073: the key
--                                                 is no current field
--       {"pw": "$argon2id$…", "title": "e"}      a copy stored as a jsonb string
--                                                 (the shape 009 unwrapped): `?|`
--                                                 matches nothing in a string,
--                                                 and the view unwraps it
--
-- The API served neither: `serializeSnapshot` keeps current fields only and
-- leaves a password one out. This is the SQL path 074 was written for.
--
-- A key goes when it names a current `password` field, or when it names no
-- current field and holds a password hash (the PHC prefixes `isPasswordHash`
-- recognises, field-types/index.ts). A current non-password field keeps what it
-- holds: a text field may store a hash on purpose. A double-encoded copy that
-- loses a key is stored unwrapped, the shape 009 gave the rest.
--
-- Out of reach, as for 074: a row whose tenant no role can make visible (NULL,
-- or a tenant deleted before tenant purge), since the owner is bound by the same
-- FORCE RLS. No request role reads those either.
--
-- Same tenant loop as 074. Re-runnable: a scrubbed row no longer matches.

-- What to take out of one copy, or NULL when nothing goes. Temporary: it exists
-- for this file only (074 needs TEMPORARY for its table as well).
CREATE FUNCTION pg_temp.zv_084_scrub(j jsonb, pw text[], kept text[])
  RETURNS jsonb
  LANGUAGE sql IMMUTABLE
  AS $f$
  SELECT CASE WHEN cardinality(s.gone) > 0 THEN s.o - s.gone END
    FROM (
      SELECT u.o,
             ARRAY(SELECT e.key FROM jsonb_each(u.o) e
                    WHERE e.key = ANY (pw)
                       OR (NOT e.key = ANY (kept)
                           AND jsonb_typeof(e.value) = 'string'
                           AND (e.value #>> '{}') ~ '^\$(argon2(i|d|id)|2[aby]?|scrypt)\$')) AS gone
        FROM (
          SELECT CASE WHEN jsonb_typeof(j) = 'string' AND left(j #>> '{}', 1) = '{'
                           AND pg_input_is_valid(j #>> '{}', 'jsonb')
                      THEN (j #>> '{}')::jsonb ELSE j END AS o
        ) u
       WHERE jsonb_typeof(u.o) = 'object'
         -- Cheap before jsonb_each: an object 074 already scrubbed holds no hash.
         AND (jsonb_typeof(j) = 'string' OR j::text ~ '\$(argon2(i|d|id)|2[aby]?|scrypt)\$')
    ) s
$f$;

DO $$
DECLARE
  t uuid;
BEGIN
  PERFORM set_config(
    'zveltio.visible_tenants',
    coalesce((SELECT string_agg(id::text, ',') FROM zv_tenants), ''),
    true);

  CREATE TEMP TABLE zv_084_fields ON COMMIT DROP AS
    SELECT c.name,
           coalesce(array_agg(f->>'name') FILTER (WHERE f->>'type' = 'password'), '{}') AS pw,
           coalesce(array_agg(f->>'name') FILTER (WHERE f->>'type' IS DISTINCT FROM 'password'),
                    '{}') AS kept
      FROM zvd_collections c,
           jsonb_array_elements(CASE WHEN jsonb_typeof(c.fields) = 'array'
                                     THEN c.fields ELSE '[]'::jsonb END) f
     WHERE f->>'name' IS NOT NULL
     GROUP BY c.name;

  FOR t IN
    SELECT DISTINCT r.tenant_id
      FROM zv_revisions r LEFT JOIN zv_084_fields p ON p.name = r.collection
     WHERE pg_temp.zv_084_scrub(r.data, coalesce(p.pw, '{}'), coalesce(p.kept, '{}')) IS NOT NULL
        OR pg_temp.zv_084_scrub(r.delta, coalesce(p.pw, '{}'), coalesce(p.kept, '{}')) IS NOT NULL
  LOOP
    -- As that tenant: the RESTRICTIVE own-node UPDATE policy filters any other row out.
    PERFORM set_config('zveltio.current_tenant', t::text, true);
    UPDATE zv_revisions r
       SET data = coalesce(x.data, r.data),
           delta = coalesce(x.delta, r.delta)
      FROM (
        SELECT r2.id,
               pg_temp.zv_084_scrub(r2.data, coalesce(p.pw, '{}'), coalesce(p.kept, '{}')) AS data,
               pg_temp.zv_084_scrub(r2.delta, coalesce(p.pw, '{}'), coalesce(p.kept, '{}')) AS delta
          FROM zv_revisions r2 LEFT JOIN zv_084_fields p ON p.name = r2.collection
         WHERE r2.tenant_id = t
      ) x
     WHERE r.id = x.id AND (x.data IS NOT NULL OR x.delta IS NOT NULL);
  END LOOP;

  DROP TABLE zv_084_fields;
  PERFORM set_config('zveltio.current_tenant', '', true);
  PERFORM set_config('zveltio.visible_tenants', '', true);
END $$;

DROP FUNCTION pg_temp.zv_084_scrub(jsonb, text[], text[]);

-- DOWN
-- Nothing to undo: the removed hashes are not recoverable, and putting them
-- back is exactly what this migration exists to prevent.
SELECT 1;
