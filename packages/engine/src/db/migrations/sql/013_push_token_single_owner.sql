-- 013_push_token_single_owner.sql
--
-- A device token identifies a DEVICE, so at most one account may hold it.
--
-- `zvd_push_tokens` was created `UNIQUE (user_id, token)`, which makes the pair
-- unique and the token itself free. `POST /api/notifications/push-tokens` takes
-- the token from the request body, so any authenticated user could register a
-- token that already belonged to somebody else, and `sendPushToUser` selects by
-- `user_id` — so the caller's own notifications were then delivered to a device
-- they do not own. Not a read: the caller never sees the victim's
-- notifications. What they get is the ability to put a push on someone else's
-- phone wearing the platform's identity, which is the thing people act on
-- without reading.
--
-- WHICH ROW SURVIVES, AND WHY
--
-- The most recently updated one. A device token is reissued by the OS and
-- travels with whoever last signed in on that device, so the newest
-- registration is the only claim that current facts support; an older row for
-- the same token describes a session that has since been replaced. `updated_at`
-- is maintained by the upsert in the route, `created_at` breaks a tie, and `id`
-- breaks the tie after that so the choice is deterministic on a database where
-- both timestamps collide.
--
-- Deleted rows are kept, so the DOWN below is a real reversal rather than a
-- constraint swap that silently discards the evidence.

CREATE TABLE IF NOT EXISTS zvd_push_tokens_superseded_013 (
  id          uuid PRIMARY KEY,
  user_id     text NOT NULL,
  token       text NOT NULL,
  platform    text NOT NULL,
  device_name text,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY token
           ORDER BY updated_at DESC, created_at DESC, id DESC
         ) AS rn
    FROM zvd_push_tokens
)
INSERT INTO zvd_push_tokens_superseded_013 (id, user_id, token, platform, device_name, created_at, updated_at)
SELECT t.id, t.user_id, t.token, t.platform, t.device_name, t.created_at, t.updated_at
  FROM zvd_push_tokens t
  JOIN ranked r ON r.id = t.id
 WHERE r.rn > 1
ON CONFLICT (id) DO NOTHING;

DELETE FROM zvd_push_tokens
 WHERE id IN (SELECT id FROM zvd_push_tokens_superseded_013);

-- The pair constraint is now implied by the token one; keeping both would cost
-- a second index that can never refuse anything the first accepts.
ALTER TABLE zvd_push_tokens DROP CONSTRAINT IF EXISTS zvd_push_tokens_user_id_token_key;
ALTER TABLE zvd_push_tokens ADD CONSTRAINT zvd_push_tokens_token_key UNIQUE (token);

-- DOWN
-- Put the pair constraint back first: the superseded rows cannot be restored
-- while a unique token is enforced.
ALTER TABLE zvd_push_tokens DROP CONSTRAINT IF EXISTS zvd_push_tokens_token_key;
ALTER TABLE zvd_push_tokens ADD CONSTRAINT zvd_push_tokens_user_id_token_key UNIQUE (user_id, token);

INSERT INTO zvd_push_tokens (id, user_id, token, platform, device_name, created_at, updated_at)
SELECT id, user_id, token, platform, device_name, created_at, updated_at
  FROM zvd_push_tokens_superseded_013
ON CONFLICT (id) DO NOTHING;

DROP TABLE IF EXISTS zvd_push_tokens_superseded_013;
