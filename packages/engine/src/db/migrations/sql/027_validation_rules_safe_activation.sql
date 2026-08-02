-- Validation rules start enforcing. Existing ones do not.
--
-- `zv_validation_rules` shipped with a management UI, an extension, a rule
-- engine and this table — and nothing ever called `validateRecord`. An
-- administrator could write a rule, see it listed as active, and it did
-- nothing. The constraint they believed they had put in place was not there.
--
-- `processInput` now applies them, which is the single point every write goes
-- through (the API handlers, import, and sync). That is the fix, and on its own
-- it would be a nasty upgrade: every rule anyone ever saved, on any install,
-- would begin rejecting writes that have been succeeding for months. Nobody
-- authored those rules against enforcement — they never saw one refuse
-- anything — so there is no reason to believe the data conforms to them.
--
-- So the feature is switched on for rules written from here, and off for rules
-- written before. An operator re-enables the ones they still want, having seen
-- the release note, one at a time, on a system where turning one on has a
-- visible effect. New rules are active by default (the column default is
-- unchanged), so the UI behaves as it always claimed to.
--
-- Idempotent: re-running only touches rows that were created before this
-- migration first ran, and after the first run there are none left with
-- `is_active = TRUE` from that era.

DO $$
DECLARE
  affected INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'zv_validation_rules'
  ) THEN
    RETURN;
  END IF;

  UPDATE zv_validation_rules
     SET is_active = FALSE,
         updated_at = NOW()
   WHERE is_active = TRUE
     AND created_at < NOW();

  GET DIAGNOSTICS affected = ROW_COUNT;

  IF affected > 0 THEN
    RAISE WARNING
      'Validation rules are now enforced on writes. % pre-existing rule(s) were '
      'DISABLED so this upgrade does not start rejecting writes against rules that '
      'never ran. Review them in Studio (Developer -> Validation) and re-enable the '
      'ones you want: UPDATE zv_validation_rules SET is_active = TRUE WHERE id = ''<id>'';',
      affected;
  END IF;
END $$;
