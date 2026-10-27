-- 102_api_key_member_issued.sql
--
-- A key a member issued for themselves at /api/me/api-keys (ADR 0010), told
-- from one an administrator issued at /api/api-keys. The rate limiter counts a
-- member's keys against the member, so issuing another key is not another
-- budget; an administrator's keys keep a bucket each, as before. Every existing
-- key was issued by an administrator: false.

ALTER TABLE zv_api_keys ADD COLUMN IF NOT EXISTS member_issued boolean NOT NULL DEFAULT false;

-- DOWN

ALTER TABLE zv_api_keys DROP COLUMN IF EXISTS member_issued;
