-- 107_seed_anon_read_rate_limit.sql
--
-- The tier for anonymous reads of the data API (ADR 0017): the data API now
-- serves a request with no session and no key as the tenant's `public` role,
-- under a limit of its own, per address. A row, as 019 gave every other tier, so
-- it can be tuned (`PATCH /api/admin/rate-limits/anon-read`) and is listed.
--
-- The values are the compiled default (`anonymousReadRateLimit` in
-- middleware/rate-limit.ts), so seeding changes no limit. DO NOTHING: an
-- operator's own row stays.

INSERT INTO zv_rate_limit_configs (key_prefix, window_ms, max_requests, description) VALUES
  ('anon-read', 60000, 100, 'Anonymous data API reads, per IP')
ON CONFLICT (key_prefix) DO NOTHING;

-- DOWN

-- Deliberately empty, as 019's: the row at its seeded value equals the compiled
-- default, and deleting it would discard what an operator tuned.
