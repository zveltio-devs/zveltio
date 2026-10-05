-- 056_api_key_own_limit.sql
--
-- `zv_api_keys.rate_limit` becomes the key's OWN limit, in requests per hour,
-- and starts being enforced (owner decision 2026-10-05). The limiter counts it
-- as a second bucket next to the tier's (and god's `apikey:<id>` override), so
-- it can only make a key stricter. NULL = no own limit.
--
-- Until now no limiter read the column, so every value in it is the old
-- default (1000), never a choice anyone made and never enforced. Enforcing
-- them as they stand would cut every existing integration to ~16 requests a
-- minute, so they are cleared.
--
-- squawk's ban-drop-not-null is for a client that reads the column as always
-- set. In the engine only the limiter reads it, and NULL means "no own limit"
-- there; Studio's list shows `—`. Nothing in the SDK, the CLI or
-- ../zveltio-extensions reads it. A replica of the previous release during a
-- rolling upgrade still writes 1000 on create, and this release enforces it:
-- a key created through an old replica during that window gets 1000/hour
-- until an admin clears it. So the drop is deliberate, and ignored for this
-- file only.

-- squawk-ignore-file ban-drop-not-null

-- Re-runnable. It runs again only after a rollback, whose DOWN put the old
-- default back — which is again no one's choice, so clearing it is right.

ALTER TABLE zv_api_keys ALTER COLUMN rate_limit DROP NOT NULL;
ALTER TABLE zv_api_keys ALTER COLUMN rate_limit DROP DEFAULT;
UPDATE zv_api_keys SET rate_limit = NULL WHERE rate_limit IS NOT NULL;

-- DOWN

UPDATE zv_api_keys SET rate_limit = 1000 WHERE rate_limit IS NULL;
ALTER TABLE zv_api_keys ALTER COLUMN rate_limit SET DEFAULT 1000;
ALTER TABLE zv_api_keys ALTER COLUMN rate_limit SET NOT NULL;
