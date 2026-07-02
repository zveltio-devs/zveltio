# Local "fire test" — the whole stack, every extension, real data

A hands-on smoke of Zveltio the way an evaluator would hit it: engine + Studio,
**all 54 extensions enabled**, and the 5 business templates seeded with sample
data. Meant for WSL / Linux.

## Prerequisites

- **Bun** ≥ 1.3 and **Postgres 16+** (18 recommended) reachable from WSL.
- The **`zveltio-extensions`** repo checked out next to this one
  (`../zveltio-extensions`).
- A database for the run. The engine connects to an existing DB (it does not
  create it):

  ```bash
  createdb zveltio_firetest      # or: psql -c 'CREATE DATABASE zveltio_firetest;'
  ```

  > The engine's DB role should be **non-superuser** for the multi-tenant RLS to
  > bind (a superuser/BYPASSRLS role skips row-level security). Fine to ignore for
  > a quick single-tenant click-through; required if you're testing tenant isolation.
  > See [`MULTI-TENANT-ENABLEMENT.md`](MULTI-TENANT-ENABLEMENT.md).

## One command

From the `zveltio/` repo root, inside WSL:

```bash
bash scripts/fire-test.sh
```

It boots the engine (auto-migrates), creates an admin, enables every extension,
seeds the templates, and leaves the engine running. Defaults:

| Var | Default |
| --- | --- |
| `DATABASE_URL` | `postgresql://rlstest:rlstest@localhost:5432/zveltio_firetest` |
| `EXTENSIONS_DIR` | `../zveltio-extensions` |
| `PORT` | `3000` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@zveltio.com` / `Test12345` |

Override any of them: `DATABASE_URL=… PORT=8080 bash scripts/fire-test.sh`.

Then, in a second terminal, open the Studio:

```bash
cd packages/studio && bun run dev     # → http://localhost:5173
```

## What to click

- **`/admin/templates`** — install a template; it should end as a *working app with
  rows*, not empty tables (that's the beta.26 seed feature).
- **`/admin/collections/erd`** — the visual ERD designer (drag, relations, export).
- **`/admin/marketplace`** — enable/disable extensions; each SDUI extension page
  should render a populated table (the runtime probe gates this in CI, but the eye
  test catches CSS/UX).
- **`/admin/tenants`** — create a tenant, add a member with a per-tenant role.

## Expected rough edges

- A few extensions need a **Postgres extension** the base image may lack
  (`postgis`, `pg_trgm`); those report an enable error and are safe to skip — the
  bring-up continues. Install the PG extension if you want them.
- CSS / layout polish on individual extension pages is exactly the kind of thing
  this test surfaces — note them per page; they're quick follow-ups.

## Cleanup

`Ctrl-C` in the fire-test terminal stops the engine. Drop the DB to reset:

```bash
dropdb zveltio_firetest
```

The engine log streams to `/tmp/zveltio-firetest.log`.
