-- Make "full access" something an operator chose, not something they defaulted into.
--
-- `checkAccess` for an api_key principal reads:
--
--     if (scopes.length > 0) { ...enforce... }
--     return true;
--
-- so an EMPTY scope array skips enforcement entirely. The create route defaults
-- `scopes` to `[]`, and so does this column. `POST /api/api-keys {"name":"x"}`
-- therefore mints a key that can read, create, update and delete every `zvd_*`
-- collection in its tenant, forever — `expires_at` is optional too.
--
-- The comment in the code says so plainly ("Empty array = full access") and that
-- is the problem: to every human being who fills in a form, "no permissions
-- selected" means "cannot do anything". Here it meant the opposite, and the
-- operator most likely to leave the field blank is the one aiming for least
-- privilege.
--
-- The code now treats `[]` as deny-all. That flip would silently break every key
-- already issued this way, so this migration writes down what those keys can do
-- TODAY, explicitly, before the meaning of the empty array changes. Nothing
-- gains a permission it did not already have; the grant simply stops being
-- implicit.
--
-- After this, `[]` means what it looks like, and a full-access key has to say
-- `[{"collection":"*","actions":["*"]}]` out loud.

DO $$
DECLARE
  n integer;
BEGIN
  UPDATE zv_api_keys
    SET scopes = '[{"collection":"*","actions":["*"]}]'::jsonb
    WHERE scopes IS NULL
       OR jsonb_typeof(scopes) <> 'array'
       OR jsonb_array_length(scopes) = 0;
  GET DIAGNOSTICS n = ROW_COUNT;

  IF n > 0 THEN
    RAISE WARNING '[api-keys] % key(s) had no scopes and therefore full access to every collection. Their access is now written down explicitly — review them at /admin/api-keys and narrow any that should not be tenant-wide.', n;
  END IF;
END
$$;

-- New keys default to no access rather than all access. A key with an empty
-- scope list is refused by `checkAccess`, which is what the empty list looks
-- like it means.
ALTER TABLE zv_api_keys ALTER COLUMN scopes SET DEFAULT '[]'::jsonb;

-- DOWN
-- Deliberately not reversed. Undoing it would mean deleting the explicit
-- wildcard scopes, which under the OLD code meant full access and under the new
-- code means none — so a rollback that "restored" `[]` would lock out every key
-- this migration touched. The explicit form is correct under both.
