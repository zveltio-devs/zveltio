-- Per-user ERD layouts for the schema-diagram view.
--
-- Each user can drag tables around to suit their mental model. The
-- previous (localStorage-only) implementation tied layouts to one browser,
-- which broke when users moved between work + home or shared sessions.
--
-- Design notes:
--   * `user_id` references the `user` table (better-auth). ON DELETE
--     CASCADE so a deleted user doesn't leave orphan rows.
--   * Float-not-numeric for x/y: ERDs don't need decimal precision and
--     float is cheaper. We round to int in the client anyway.
--   * No FK on `collection_name`: collections can be renamed, and the
--     application code already handles "layout points at gone collection"
--     by falling back to the auto-grid position. A FK would force us to
--     cascade-update on rename and cascade-delete on drop, neither of
--     which is the behavior we want here.

CREATE TABLE IF NOT EXISTS zv_erd_layouts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  collection_name TEXT NOT NULL,
  x               DOUBLE PRECISION NOT NULL,
  y               DOUBLE PRECISION NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, collection_name)
);

-- Used by GET /api/erd/layout to fetch every position for the current user.
CREATE INDEX IF NOT EXISTS idx_zv_erd_layouts_user
  ON zv_erd_layouts (user_id);
