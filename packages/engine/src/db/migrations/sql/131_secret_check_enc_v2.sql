-- 131_secret_check_enc_v2.sql
--
-- ADR 0059 (amendment 2026-11-21): field values are now written as `enc:v2:`
-- (key id + associated data naming tenant, collection, field and record). A
-- `secret` column carries a CHECK that keeps it ciphertext or NULL, and the
-- CHECK spelled the only envelope there was, `LIKE 'enc:v1:%'`, so every v2
-- write into an existing secret column would fail it.
--
-- Each such CHECK becomes `~ '^enc:v[12]:'` (lib/data/field-type-registry.ts,
-- `secretCheckSql`, which new columns get). NOT VALID: the new predicate is
-- looser than the validated one it replaces, so every stored row already
-- satisfies it, and validating would scan every secret table under the ACCESS
-- EXCLUSIVE lock this ALTER takes. New writes are checked as with any CHECK.
--
-- Re-runnable: a CHECK already rewritten no longer matches the old spelling.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT k.conname, c.relname, a.attname
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.conkey[1]
     WHERE k.contype = 'c'
       AND array_length(k.conkey, 1) = 1
       AND pg_get_constraintdef(k.oid) LIKE '%~~ ''enc:v1:\%''::text%'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I DROP CONSTRAINT %I, ADD CONSTRAINT %I CHECK (%I IS NULL OR %I ~ %L) NOT VALID',
      r.relname, r.conname, r.conname, r.attname, r.attname, '^enc:v[12]:'
    );
  END LOOP;
END $$;

-- DOWN
-- Back to the v1-only spelling, NOT VALID again: a value already written as
-- `enc:v2:` stays, and an engine from before this migration cannot read it.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT k.conname, c.relname, a.attname
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.conkey[1]
     WHERE k.contype = 'c'
       AND array_length(k.conkey, 1) = 1
       AND pg_get_constraintdef(k.oid) LIKE '%~ ''^enc:v[12]:''::text%'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I DROP CONSTRAINT %I, ADD CONSTRAINT %I CHECK (%I IS NULL OR %I LIKE %L) NOT VALID',
      r.relname, r.conname, r.conname, r.attname, r.attname, 'enc:v1:%'
    );
  END LOOP;
END $$;
