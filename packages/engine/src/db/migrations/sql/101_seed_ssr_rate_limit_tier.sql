-- 101_seed_ssr_rate_limit_tier.sql
--
-- A row for the `ssr` tier (middleware/rate-limit.ts `ssrRateLimit`: server-side
-- renders of the public client), so it can be tuned like every other tier, as
-- 019 did for the tiers before it. The values are the compiled default, so
-- seeding changes no limit. DO NOTHING: a row inserted by hand is kept.

INSERT INTO zv_rate_limit_configs (key_prefix, window_ms, max_requests, description) VALUES
  ('ssr', 60000, 300, 'Server-side renders of the public client, per IP')
ON CONFLICT (key_prefix) DO NOTHING;

-- DOWN

-- Deliberately empty, as in 019: the previous engine reads the row as the
-- limit it compiles in.
