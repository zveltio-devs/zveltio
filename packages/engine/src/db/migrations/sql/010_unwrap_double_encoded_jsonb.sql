-- 010_unwrap_double_encoded_jsonb.sql
--
-- The rest of the family 009 belongs to. `zv_revisions` was one site of a
-- repository-wide pattern: bind `JSON.stringify(value)` to a `jsonb` column and
-- it is stored as a jsonb STRING containing JSON text, not as the value.
--
-- Found by asking the database rather than by reading code — every populated
-- `jsonb` column on an instance the real routes had written to:
--
--     zv_api_keys.scopes           15 of 15 rows   jsonb_typeof = 'string'
--     zv_license_audit.details    112 of 112
--     zv_notifications.metadata    22 of 22
--     zv_settings.value             4 of 8         (the other four were correct)
--
-- The writers are fixed in the same change, through `lib/jsonb.ts`. The order
-- matters: repairing the data first would leave new rows arriving in the old
-- shape.
--
-- ── What each one cost ──────────────────────────────────────────
--
-- `zv_api_keys.scopes` is the one that matters most. Stored as a jsonb string,
-- `scopes @> '[...]'` matches nothing and `scopes ? 'x'` is false, so any
-- authorization written the natural SQL way would answer "no scope" for a key
-- that has it. Nothing in the tree does that today — both readers
-- (`lib/data/auth.ts`, `routes/admin.ts`) accept either shape, and the auth one
-- fails CLOSED on an unparseable value — which is exactly why it went unnoticed.
--
-- `zv_notifications.metadata` and `zv_license_audit.details` have no reader-side
-- compensation at all. They are typed `Record<string, unknown>` over a value that
-- is a string, so a key lookup yields undefined rather than the stored data.
--
-- `zv_settings.value` legitimately holds any JSON type, and that is why it was
-- mixed: a scalar setting SHOULD be a jsonb string. `site_url` was written at
-- bootstrap and is correct; `language` and `timezone` went through the settings
-- routes and arrived wrapped one extra time — `value #>> '{}'` returned `"en"`
-- with the quotes rather than `en`. Only the doubly-wrapped ones are touched
-- here; see the guard below.
--
-- ── Why this is written the way it is ───────────────────────────
--
-- The `left(… , 1) IN ('{', '[')` guard, inherited from 009 and load-bearing for
-- the same reason: `(col #>> '{}')::jsonb` on a jsonb string that is not JSON —
-- a plain note, a token, a URL — raises, and a raise aborts the whole migration.
-- Only values that look like a document are unwrapped, so a genuine jsonb string
-- stays one. That is what keeps `zv_settings.site_url` and
-- `marketplace_auth_token` untouched.
--
-- It also means `language` and `timezone` are NOT repaired here: their stored
-- text is `"en"`, which starts with a quote, not a brace. Unwrapping those
-- safely needs a stricter test than "looks like JSON", and getting it wrong
-- turns a readable setting into a null. They are left as they are — the readers
-- compensate (`routes/settings.ts` parses and falls back to raw), the writers no
-- longer produce the shape, and a wrong repair here is worse than a stale row.
--
-- `WHERE jsonb_typeof(...) = 'string'` makes every block re-runnable: rows
-- already unwrapped do not match.
--
-- Batched at 5 000, because `zv_notifications` and `zv_license_audit` grow
-- without bound and one UPDATE over either would hold row locks for the length
-- of a full rewrite.

DO $$
DECLARE
  moved BIGINT;
  total BIGINT;
BEGIN
  -- ── zv_api_keys.scopes ────────────────────────────────────────
  total := 0;
  LOOP
    WITH batch AS (
      SELECT id FROM zv_api_keys
       WHERE scopes IS NOT NULL
         AND jsonb_typeof(scopes) = 'string'
         AND left(scopes #>> '{}', 1) IN ('{', '[')
       LIMIT 5000
    )
    UPDATE zv_api_keys t
       SET scopes = (t.scopes #>> '{}')::jsonb
      FROM batch
     WHERE t.id = batch.id;

    GET DIAGNOSTICS moved = ROW_COUNT;
    total := total + moved;
    EXIT WHEN moved = 0;
  END LOOP;
  IF total > 0 THEN
    RAISE NOTICE '010: unwrapped % double-encoded zv_api_keys.scopes value(s)', total;
  END IF;

  -- ── zv_notifications.metadata ─────────────────────────────────
  total := 0;
  LOOP
    WITH batch AS (
      SELECT id FROM zv_notifications
       WHERE metadata IS NOT NULL
         AND jsonb_typeof(metadata) = 'string'
         AND left(metadata #>> '{}', 1) IN ('{', '[')
       LIMIT 5000
    )
    UPDATE zv_notifications t
       SET metadata = (t.metadata #>> '{}')::jsonb
      FROM batch
     WHERE t.id = batch.id;

    GET DIAGNOSTICS moved = ROW_COUNT;
    total := total + moved;
    EXIT WHEN moved = 0;
  END LOOP;
  IF total > 0 THEN
    RAISE NOTICE '010: unwrapped % double-encoded zv_notifications.metadata value(s)', total;
  END IF;

  -- ── zv_license_audit.details ──────────────────────────────────
  total := 0;
  LOOP
    WITH batch AS (
      SELECT id FROM zv_license_audit
       WHERE details IS NOT NULL
         AND jsonb_typeof(details) = 'string'
         AND left(details #>> '{}', 1) IN ('{', '[')
       LIMIT 5000
    )
    UPDATE zv_license_audit t
       SET details = (t.details #>> '{}')::jsonb
      FROM batch
     WHERE t.id = batch.id;

    GET DIAGNOSTICS moved = ROW_COUNT;
    total := total + moved;
    EXIT WHEN moved = 0;
  END LOOP;
  IF total > 0 THEN
    RAISE NOTICE '010: unwrapped % double-encoded zv_license_audit.details value(s)', total;
  END IF;

  -- ── zv_settings.value ─────────────────────────────────────────
  -- Only the document-shaped ones, per the guard note above. A settings row
  -- whose stored text starts with a quote is left alone.
  total := 0;
  LOOP
    WITH batch AS (
      SELECT key FROM zv_settings
       WHERE value IS NOT NULL
         AND jsonb_typeof(value) = 'string'
         AND left(value #>> '{}', 1) IN ('{', '[')
       LIMIT 5000
    )
    UPDATE zv_settings t
       SET value = (t.value #>> '{}')::jsonb
      FROM batch
     WHERE t.key = batch.key;

    GET DIAGNOSTICS moved = ROW_COUNT;
    total := total + moved;
    EXIT WHEN moved = 0;
  END LOOP;
  IF total > 0 THEN
    RAISE NOTICE '010: unwrapped % double-encoded zv_settings.value value(s)', total;
  END IF;
END $$;
