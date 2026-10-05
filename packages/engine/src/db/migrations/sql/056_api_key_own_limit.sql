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
-- Re-runnable. It runs again only after a rollback, whose DOWN put the old
-- default back — which is again no one's choice, so clearing it is right.

ALTER TABLE zv_api_keys ALTER COLUMN rate_limit DROP NOT NULL;
ALTER TABLE zv_api_keys ALTER COLUMN rate_limit DROP DEFAULT;
UPDATE zv_api_keys SET rate_limit = NULL WHERE rate_limit IS NOT NULL;

-- DOWN

UPDATE zv_api_keys SET rate_limit = 1000 WHERE rate_limit IS NULL;
ALTER TABLE zv_api_keys ALTER COLUMN rate_limit SET DEFAULT 1000;
ALTER TABLE zv_api_keys ALTER COLUMN rate_limit SET NOT NULL;
