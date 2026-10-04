# RFC: schema as code

Status: **proposed**, 2026-10-04. Roadmap item R5. It builds on the owner's
format decisions of 2026-10-04: JSON files plus migrations, one file per
collection, a plan before apply.

## 1. Problem

Today a Zveltio schema lives only in the database. Collections, fields,
relations, row rules and permissions are made in Studio or through the API,
and they are stored in `zvd_collections`, `zvd_relations`, `zvd_rls_policies`,
`zvd_column_permissions`, `zv_validation_rules`, `zv_roles` and
`zvd_permissions`.

As a result, a team cannot:

- review a schema change in a pull request;
- reproduce production's schema on a laptop or in CI;
- promote a change from staging to production other than by clicking it again.

Schema branches (`docs/engine/collections.md#schema-branches`) diff and merge
inside one database. They do not leave it.

The comparable products have this:

- Directus: `schema snapshot` / `schema apply`;
- PocketBase: it writes a JS migration for every change made in its UI;
- Supabase: `db diff`.

Zveltio should keep "click in Studio and it works" and also give the git
workflow.

## 2. Goals and non-goals

**Goals.**

- `zveltio schema pull` writes the live schema to files. `zveltio schema diff`
  compares the files with an instance. `zveltio schema apply` makes the
  instance match the files.
- The files are the review surface, so their diffs must be minimal and stable.
- A fresh database plus `apply` reproduces the instance's schema exactly. The
  existing installed-schema snapshot gate checks this (acceptance, §9).
- Every change goes through the code path Studio uses today: the DDL queue,
  Ghost DDL, `applyTenantRLS` and the policy reconcile. There is no second DDL
  path.

**Non-goals.**

- Data rows, including seed data, are not exported. A seed mechanism can come
  later, separately.
- Secrets are not exported.
- Tenant-specific state is not exported: memberships, per-tenant roles and
  per-tenant permission rows.
- Extension-owned schema is not exported. Extensions already ship their own
  migrations.
- BYOD (`is_managed = false`) tables are not exported in v1.

## 3. Layout

```
schema/
  zveltio-schema.json          # format version + $schema URL; nothing else
  collections/<name>.json      # one per collection
  roles.json                   # roles and their global permissions
  settings.json                # schema-relevant engine settings (allowlist)
  migrations/<id>.json         # only for changes state cannot express
```

The directory defaults to `./schema`, and `--dir` changes it.

Each file carries `"$schema": "https://zveltio.com/schema/v1/<kind>.json"`. The
JSON Schemas are generated from the engine's zod schemas
(`CollectionSchema`, `FieldSchema`, …), so the editor schema and the engine
validation cannot drift. They are published with each release and are also
served by the engine at `/api/schema/json-schema/<kind>.json`.

## 4. File contents

### 4.1 `collections/<name>.json`

The file holds everything that belongs to one collection:

```json
{
  "$schema": "https://zveltio.com/schema/v1/collection.json",
  "name": "posts",
  "displayName": "Posts",
  "icon": "file-text",
  "routeGroup": "private",
  "fields": [
    { "name": "title", "type": "text", "required": true },
    { "name": "author", "type": "m2o", "options": { "related": "users" } }
  ],
  "indexes": [{ "fields": ["author", "title"], "unique": false }],
  "relations": [
    { "name": "posts_author", "type": "m2o", "field": "author",
      "target": "users", "onDelete": "SET NULL" }
  ],
  "rowRules": [
    { "role": "editor", "field": "author", "op": "eq", "value": "$user.id" }
  ],
  "columnPermissions": [
    { "role": "viewer", "column": "internal_note", "read": false, "write": false }
  ],
  "validation": [
    { "field": "title", "rule": "length", "config": { "max": 120 },
      "message": "Title is too long" }
  ]
}
```

- Field order is kept as declared, because it is the order Studio shows.
  Every other array is sorted by its natural key: relations by `name`, index
  by `fields`, rules by `(role, field)`.
- **Engine-added columns are not listed**: `id`, `tenant_id`, `status`,
  `created_at` and the rest. They are implied by the format version.
- **Relations live in the source collection's file.** For an m2m, the
  junction table is derived and not listed.

### 4.2 `roles.json`

```json
{
  "$schema": "https://zveltio.com/schema/v1/roles.json",
  "roles": [
    { "name": "editor", "description": "Writes posts",
      "permissions": [{ "resource": "posts", "actions": ["create", "read", "update"] }] }
  ]
}
```

- The file holds only `zvd_permissions` rows with domain `*`, the global
  grants.
- Rows scoped to one tenant id, and every `g` (user→role) row, are tenant
  state and stay out.
- The built-in roles appear only when their permissions differ from the
  seeded defaults.

### 4.3 `settings.json`

The file holds an **allowlist** of settings that change behaviour schema-wide,
for example the default locale and the field-encryption toggles. The engine
owns the allowlist (`SCHEMA_SETTINGS` in code), and a key not on it is
neither pulled nor applied.

Environment-specific values are refused at the gate, so the "overlay" question
does not arise in v1. These values are already environment variables, which
is where they belong. **Decision: no per-environment overlay in v1.** We will
revisit it if a real case appears.

### 4.4 `migrations/<id>.json`

A migration exists only for what a diff of two states cannot express without
guessing:

| Change | Why state is not enough | Op |
|---|---|---|
| Rename a field or collection | It looks like drop + add, which loses data | `renameField`, `renameCollection` |
| Type change that needs a conversion | The cast is a choice | `changeFieldType` with `using` from a closed list (`text`, `int`, `numeric`, `date`, `timestamptz`, `bool`, `json`) |
| Drop a field or collection | A drop must be intended, not inferred from absence | `dropField`, `dropCollection` |
| Remove a role | Users holding it lose access | `dropRole` |

```json
{ "id": "20261004T120000-rename-title",
  "ops": [{ "op": "renameField", "collection": "posts", "from": "title", "to": "headline" }] }
```

- **Ops, not SQL.** A schema file is applied by a tenant admin as often as by
  a god, and the collection API deliberately never gives a tenant admin SQL.
  Arbitrary SQL stays a god-only tool (`/api/admin/sql`).
- Ids sort by time, so concurrent branches rarely collide. Two migrations with
  the same id are an error.
- Applied migrations are recorded in a new table, `zv_schema_migrations`
  (`id`, `checksum`, `applied_at`, `applied_by`), so that `apply` runs each one
  once. An applied migration whose file has changed is refused, the same rule
  as the engine's own migrations.

## 5. Determinism

`pull` and Studio's writer use one serializer (`lib/schema-artifact/serialize.ts`):

- keys sorted, except `$schema` and `name`, which come first;
- arrays sorted as in §4.1;
- 2-space indentation, `\n` line endings, a trailing newline;
- default values omitted (for example `required: false`), so adding a new
  optional property to the format does not rewrite every file.

A CI gate runs `pull` twice on the fixture instance and requires byte-identical
output.

## 6. Commands

| Command | What it does |
|---|---|
| `zveltio schema pull` | Writes the files from a live instance. Removes the files of collections that no longer exist. Never writes migrations. |
| `zveltio schema diff` | Prints the plan `apply` would run, without changing anything. Exits 0 when there is nothing to do, so CI can fail on drift. |
| `zveltio schema apply` | Runs pending migrations first, in id order, then the state diff. **Shows the plan and asks**, unless `--yes`. A destructive step without a matching migration refuses, with or without `--allow-destructive`. |

The plan reads like `terraform plan`:

```
+ comments  create collection (4 fields)
- drafts    drop collection   (destructive)
+ posts     add field summary (text)
~ posts     alter field author (indexed)
```

- **Destructive** means `dropField`, `dropCollection`, `changeFieldType` or a
  removed role (`dropRole`). Each needs both a migration and
  `--allow-destructive`. A narrowed column permission is not on the list: it
  loses no data, narrowing is the point of the change, and the plan already
  shows it for review.
- Indexes are not steps of their own: they follow from a field's `unique` and
  `indexed` flags, so they show as `alter field`.
- **Additions apply straight from the diff**: fields, indexes, relations,
  rules, permissions, roles and settings.
- **Plan.** `diff` sends the files to `POST /api/admin/schema/plan`, which
  compares them with the instance's own export and returns the steps. It
  changes nothing.
- **Execution.** `apply` calls a new god-only route, `POST /api/admin/schema/apply`,
  with the files' content. The engine validates the content, computes the plan
  itself, and runs it through the same `DDLManager` and DDL-queue calls the
  collection routes use. A large table goes through Ghost DDL, as it does
  today. It computes the plan with the same function as `/schema/plan`.
- **Locking.** `apply` holds one advisory lock (`db/advisory-lock.ts`), so two
  CI jobs cannot interleave.

## 7. Studio and the dev loop

- **In dev** (`NODE_ENV !== 'production'` and `ZVELTIO_SCHEMA_DIR` set), every
  committed schema change also writes the affected files, the way PocketBase
  does. A rename or drop made in Studio also writes its migration. That is the
  only reliable moment to capture the intent.
- **In production** Studio does not write files. `pull` is how changes made
  there get back into git.
- **Schema branches** stay as they are. A later step can export a branch as a
  diff against the files. That is not part of v1.

## 8. Types

- `zveltio generate-types --from schema/` builds the SDK types from the files,
  with no running engine.
- The existing `--url` path stays.
- Both paths share one generator, so they cannot disagree. This is the R7
  dependency.

## 9. Acceptance

1. Take an instance with collections, every relation kind, indexes, row rules,
   column permissions, validation rules and custom roles. Run `pull`, then
   `apply` on a fresh database. The installed-schema snapshot
   (`scripts/schema-snapshot.ts`) of the two must be equal.
2. `pull` → `apply` → `pull` gives byte-identical files.
3. Renaming a field without a migration produces a plan that refuses
   (drop + add). With the migration, the data survives.
4. A tenant admin cannot reach `POST /api/admin/schema/apply`. A file that names a
   tenant id is refused.

## 10. Delivery

| Step | Content | Size |
|---|---|---|
| 1 | Serializer + `GET /api/admin/schema/export` + `schema pull` + determinism gate + JSON Schemas | M |
| 2 | Plan computation (`POST /api/admin/schema/plan`) + `schema diff` | M |
| 3 | `apply` for additions + `zv_schema_migrations` + migration ops + the acceptance test | L |
| 4 | Studio dev-mode writer (including rename/drop migrations) | M |
| 5 | `generate-types --from` (with R7) | S |

Each step ships alone. Step 1 is already useful as a reviewable backup.

## 11. Decisions taken in this RFC

The owner delegated these on 2026-10-04:

- **No per-environment overlay** in v1; environment values stay environment
  variables (§4.3).
- **Migrations are ops, not SQL** (§4.4).
- **Extension and BYOD collections are out** of the artifact (§2).
- **Relations live in the source collection's file**, and junctions are
  derived (§4.1).
- **Global permissions only** in `roles.json`. Per-tenant grants and
  memberships are tenant state (§4.2).
- **The engine computes the plan.** The CLI only ships files and renders the
  answer, so there is one implementation of "what changes" (§6).
