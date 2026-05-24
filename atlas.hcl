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
  # with monotonic numbering — our 001_initial.sql / 002_*.sql
  # convention works.
  migration {
    dir = "file://packages/engine/src/db/migrations/sql"
    # `goose` format: one file per version, named `<seq>_<name>.sql`.
    # That matches our convention exactly.
    #
    # Atlas's "atlas" default expects 14-digit timestamps
    # (20240101120000_init.sql) — we don't use those. `golang-migrate`
    # wants paired `.up.sql` + `.down.sql` files; we use one file with
    # a `-- DOWN` marker parsed by our own `parseMigrationSql`. `goose`
    # is the closest match: Atlas reads the UP block and runs its
    # destructive / lock / data-depend analyzers on it. Our `-- DOWN`
    # doesn't match goose's `-- +goose Down` syntax, so Atlas treats
    # each file as UP-only — exactly what we want for lint purposes.
    #
    # Value MUST be a bare identifier (not a quoted string). Atlas
    # rejected the previous `format = "up.sql"` with
    # `unknown dir format "up.sql"` precisely because of both: not a
    # valid format name AND quoted.
    format = goose
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
