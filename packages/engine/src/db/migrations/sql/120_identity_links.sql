-- 120_identity_links.sql
--
-- ADR 0039 decision 9: directory provisioning is a narrow engine contract. A
-- provider (an extension holding `identity:provision`, e.g. `auth/scim`)
-- reaches only the accounts it provisioned, in the tenant it runs in. This is
-- the engine's record of that: one row per account a provider provisioned in a
-- tenant, keyed by the provider's own id for it (`subject`).
--
-- `active` is the flag the provider last set. `suspended_at` / `held_valid_to`:
-- on a multi-tenant instance `setActive(false)` ends the membership here and
-- keeps the end date the business had set, so `setActive(true)` can put it back
-- while the membership still carries the provider's own end.
--
-- Written only by the engine, under its own role (`asEngineRole`): the request
-- role's DML on it is revoked at every boot (tenant-manager.ts, control tables).
--
-- `auth/scim` kept the same state in its collection `scim_users`. Its rows are
-- carried over as links, the subject being the user id the identity provider
-- already holds as the SCIM `id`, so an upgraded `auth/scim` still reaches the
-- accounts it provisioned. An install without that collection copies nothing.

CREATE TABLE IF NOT EXISTS zv_identity_links (
  tenant_id     uuid        NOT NULL REFERENCES zv_tenants(id) ON DELETE CASCADE,
  provider      text        NOT NULL,
  subject       text        NOT NULL,
  user_id       text        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  active        boolean     NOT NULL DEFAULT true,
  suspended_at  timestamptz,
  held_valid_to timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider, subject),
  UNIQUE (tenant_id, provider, user_id)
);

CREATE INDEX IF NOT EXISTS zv_identity_links_user ON zv_identity_links (user_id);

DO $$
BEGIN
  IF to_regclass('public.zvd_scim_users') IS NOT NULL THEN
    INSERT INTO zv_identity_links (tenant_id, provider, subject, user_id, active,
                                   suspended_at, held_valid_to)
    SELECT s.tenant_id, 'auth/scim', s.user_id, s.user_id, COALESCE(s.active, true),
           s.suspended_at, s.held_valid_to
      FROM zvd_scim_users s
      JOIN "user" u ON u.id = s.user_id
      JOIN zv_tenants t ON t.id = s.tenant_id
    ON CONFLICT DO NOTHING;
  END IF;
END
$$;

-- DOWN

DROP TABLE IF EXISTS zv_identity_links;
