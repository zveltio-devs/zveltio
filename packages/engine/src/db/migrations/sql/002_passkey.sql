-- The passkey table Better Auth's plugin has always expected.
--
-- `auth.ts` registers `passkey()` and the sign-in screen offers "Sign in with
-- passkey", but no migration ever created the table it stores credentials in.
-- Every install therefore answered 500 on the account page:
--
--   GET /api/auth/passkey/list-user-passkeys
--   [Better Auth]: relation "passkey" does not exist
--
-- Found by loading all 37 Studio admin pages against a clean install. The
-- feature was advertised in the UI and could not work anywhere.
--
-- Columns are the plugin's declared schema (@better-auth/passkey 1.6.23),
-- quoted camelCase like `account` and `twoFactor` next to it — Better Auth maps
-- field names straight to column names, so unquoted snake_case would leave it
-- looking for columns that are not there.
--
-- A separate migration rather than an edit to 001_initial.sql: an installation
-- already carries 001 as applied, so a table added there would never reach it.

CREATE TABLE IF NOT EXISTS passkey (
  id              TEXT PRIMARY KEY,
  name            TEXT,
  "publicKey"     TEXT        NOT NULL,
  "userId"        TEXT        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "credentialID"  TEXT        NOT NULL,
  counter         INTEGER     NOT NULL DEFAULT 0,
  "deviceType"    TEXT        NOT NULL,
  "backedUp"      BOOLEAN     NOT NULL DEFAULT false,
  transports      TEXT,
  aaguid          TEXT,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Both are declared `index: true` by the plugin: it looks credentials up by
-- credentialID during assertion, and lists them by userId on the account page.
CREATE INDEX IF NOT EXISTS idx_passkey_user ON passkey ("userId");
CREATE INDEX IF NOT EXISTS idx_passkey_credential ON passkey ("credentialID");

-- No row-level security, matching `session`, `account`, `verification` and
-- `twoFactor`, which 044 explicitly disables it on. These tables are reached
-- only through Better Auth, which scopes every query by the session's own user;
-- a tenant predicate here would have nothing to read `tenant_id` from.

-- DOWN
DROP INDEX IF EXISTS idx_passkey_credential;
DROP INDEX IF EXISTS idx_passkey_user;
DROP TABLE IF EXISTS passkey;
