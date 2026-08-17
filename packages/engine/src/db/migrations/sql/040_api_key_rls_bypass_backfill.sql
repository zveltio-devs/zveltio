-- API keys created before migration 032 still bypass row-level security.
--
-- Migration 026 added the column as `NOT NULL DEFAULT true`, which wrote an
-- explicit `true` into every key that existed at the time and into every key
-- created afterwards. Migration 032 then changed the default to `false` — and
-- only the default. It contains no UPDATE, so every key created before it kept
-- its explicit `true`, and `NOT NULL` means there is no "unset" state to fall
-- back to. The result is that the security posture depends on the date a key
-- was issued, which is not a property anyone can see from the admin UI.
--
-- What such a key does: `rls.ts` returns an empty policy list for it, so the
-- key reads every tenant's rows regardless of the policies on the tables.
--
-- Only keys issued BEFORE 032 ran are reset. Keys issued after it had to pass
-- `rls_bypass: true` explicitly through `POST /api/api-keys`, and that is a
-- deliberate choice this migration has no business overturning. The cut-off is
-- read from the schema ledger rather than hardcoded, because the date differs
-- per install.
--
-- If the ledger has no record of 032 — a database migrated by some other route
-- — every bypassing key is reset. That direction is chosen on purpose: the
-- failure mode of resetting too many keys is an integration that returns fewer
-- rows and reports it, while the failure mode of resetting too few is silent
-- cross-tenant reads.
--
-- Restoring bypass on a key is deliberately not a one-click operation: there is
-- no PATCH for the field. Issue a replacement key with `rls_bypass: true`.

DO $backfill$
DECLARE
  cutoff  TIMESTAMPTZ;
  changed INTEGER;
BEGIN
  SELECT applied_at INTO cutoff
  FROM zv_schema_versions
  WHERE version = 32 AND rolled_back_at IS NULL
  ORDER BY applied_at DESC
  LIMIT 1;

  UPDATE zv_api_keys
  SET rls_bypass = false
  WHERE rls_bypass
    AND (cutoff IS NULL OR created_at < cutoff);

  GET DIAGNOSTICS changed = ROW_COUNT;

  IF changed > 0 THEN
    RAISE NOTICE
      '[040] % API key(s) no longer bypass row-level security. They were issued before the '
      'default changed and had been reading across every tenant. Re-issue with rls_bypass:true '
      'if an integration genuinely needs instance-wide reads.', changed;
  END IF;
END
$backfill$;

-- DOWN
-- Not reversible. The column cannot distinguish a key this migration reset from
-- one that was always false, and restoring cross-tenant reads to a set of keys
-- guessed by date is worse than leaving them scoped.
