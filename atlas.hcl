# Atlas config — migration safety in CI (S5-09).
#
# Atlas (ariga.io/atlas) is a database schema-migration linter. We run it
# in CI on every PR that touches `packages/engine/src/db/migrations/sql/`
# to catch destructive operations, locks held too long, and missing
# indexes before the migration lands.
#
# Reference: https://atlasgo.io/lint/analyzers

env "engine" {
  # Directory the migration files live in. Atlas expects `.sql` files
  # with monotonic numbering — our existing 001_*..073_* convention works.
  migration {
    dir = "file://packages/engine/src/db/migrations/sql"
    # Atlas's default `up.sql / down.sql` convention doesn't match ours;
    # we use a single file per migration with an optional `-- DOWN` marker
    # (parsed by `parseMigrationSql`). Atlas treats each file as a single
    # statement set — destructive analyzers still fire correctly.
    format = "up.sql"
  }

  # We don't run Atlas against a live database — only lint the SQL files
  # statically. The `dev` URL is required by Atlas to spin up its own
  # ephemeral Postgres container for syntax + semantic validation.
  dev = "docker://postgres/18-alpine/dev?search_path=public"
}

# ── Lint policy ───────────────────────────────────────────────────────────
# Severity tuning so the existing 73 migrations don't flood CI with noise.
# Tightening over time = adding entries to `error_codes`.

lint {
  # Analyzers we want to fail the build on. Catches the highest-impact
  # mistakes: destructive ops without explicit confirmation, ALTER COLUMN
  # in a way that blocks readers, missing concurrent index creation.
  destructive {
    error = true
  }
  # `concurrent_index` — CREATE INDEX without CONCURRENTLY locks the
  # whole table while the index builds. On production, this is unsafe
  # for tables > a few hundred MB.
  concurrent_index {
    error = true
  }
  # `data_depend` — ALTER COLUMN ... NOT NULL on a column that may have
  # nulls. Requires either a default or an explicit backfill.
  data_depend {
    error = true
  }
  # Locks reviewed manually for now — the analyzer is too aggressive
  # for our migrations that wrap in lock_timeout = '2s'.
  # naming, schemaqualified, etc. left at default (warning).
}
