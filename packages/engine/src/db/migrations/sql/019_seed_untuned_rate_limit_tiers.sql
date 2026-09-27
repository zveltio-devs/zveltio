-- 019_seed_untuned_rate_limit_tiers.sql
--
-- A row for every rate-limit tier that had none, so each one can be tuned.
--
-- 001 seeded six tiers: auth, api, ai, write, ddl, destructive. Seven limiters
-- were added since, each with its limit compiled in and no row here, and
-- `PATCH /api/admin/rate-limits/:tier` only updates an existing row: for these
-- it answered 404, and the only way to change the limit was a new build. They
-- were also missing from the Studio's Settings → Rate limiting list, which reads
-- this table.
--
-- The values are exactly the compiled defaults (`rateLimit({...})` in
-- middleware/rate-limit.ts, routes/edge-functions.ts and routes/permissions.ts),
-- so seeding changes no limit. `POST /api/admin/rate-limits/reset` restores the
-- same values from the same source. DO NOTHING: an operator who already inserted
-- one of these rows by hand keeps it.

INSERT INTO zv_rate_limit_configs (key_prefix, window_ms, max_requests, description) VALUES
  ('ext',                60000,  600,  'Extension routes (/ext/*)'),
  ('files',              60000,  1200, 'Public file serving (/files/*)'),
  ('form',               60000,  20,   'Public form submissions, per IP'),
  ('share',              60000,  10,   'Share-link access and passwords, per IP'),
  ('scim',               60000,  100,  'SCIM provisioning (/scim/v2/*), per IP'),
  ('edge-public',        60000,  60,   'Anonymous edge function invocations'),
  ('recovery-bootstrap', 900000, 5,    'Emergency admin recovery (/api/permissions/bootstrap)')
ON CONFLICT (key_prefix) DO NOTHING;

-- DOWN

-- Deliberately empty. The previous engine reads these rows exactly as this one
-- does, and at their seeded values they equal its compiled defaults, so leaving
-- them changes nothing; deleting them would discard what an operator tuned.
