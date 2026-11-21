# CLI Reference

The `zveltio` command-line tool for managing your Zveltio instance.

## Installation

The CLI is included in the engine package. After cloning the repository:

```bash
bun install
bun run --cwd=packages/sdk build   # the CLI imports @zveltio/sdk/codegen from the built SDK
bun run packages/cli/src/index.ts --help
```

Without the SDK build, every command (`--help` too) fails with
`Cannot find module '@zveltio/sdk/codegen'`.

Or install globally:

```bash
bun add -g @zveltio/cli
zveltio --help
```

---

## Commands

### `zveltio init [dir]`

Initialize a new Zveltio project in the specified directory (defaults to current directory).

```bash
zveltio init my-project
zveltio init my-project --template saas
```

| Option | Default | Description |
|--------|---------|-------------|
| `--template <name>` | `default` | Starter template (`default`, `saas`, `cms`) |

---

### `zveltio dev`

Start Zveltio in development mode with hot reload.

```bash
zveltio dev
zveltio dev --port 4000
zveltio dev --no-studio
```

| Option | Default | Description |
|--------|---------|-------------|
| `-p, --port <port>` | `3000` | Port to listen on |
| `--no-studio` | — | Disable Studio embed (API-only mode) |

---

### `zveltio start`

Start Zveltio in production mode.

```bash
zveltio start
zveltio start --port 8080
zveltio start --binary ./zveltio-engine
```

| Option | Default | Description |
|--------|---------|-------------|
| `-p, --port <port>` | `3000` | Port to listen on |
| `--binary <path>` | — | Path to a pre-compiled Bun binary |

---

### `zveltio migrate`

Run pending database migrations.

```bash
zveltio migrate
```

Migrations are applied in order from `packages/engine/src/db/migrations/sql/`. Already-applied migrations are skipped: a migration is pending when it has no row in `zv_schema_versions`, whatever its number, so one numbered below the last applied version still runs (with an "applied out of order" warning). `--dry-run` lists the pending files without applying them. Always run this after pulling new code or enabling new extensions.

---

### `zveltio rollback`

Roll back the last applied migration.

```bash
zveltio rollback
```

> Use with caution in production — rollbacks may be destructive if the migration dropped or renamed columns.

---

### `zveltio rotate-keys`

Rewrites every field value the engine sealed (encrypted and `secret` fields,
their revision copies, webhook secrets, the storage S3 secret) under the current
`FIELD_ENCRYPTION_KEYS` key as `enc:v2:`, bound to its row, and reports what is
left under each key id. A value no listed key opens is reported, never
rewritten. Idempotent; run it again after an interruption.

```bash
zveltio rotate-keys --dry-run                  # report only
zveltio rotate-keys --database-url postgres://… [--batch 500]
```

The npm CLI runs the engine's code from a repository checkout; on an install,
use the release binary's `zveltio rotate-keys`. Procedure and exit codes:
[security.md](../platform/security.md#zveltio-rotate-keys).

---

### `zveltio create-god`

Create a recovery override account: a `god` user, over HTTP against a running
engine. On a fresh install use the engine binary's `create-god` instead (see
[installation.md](../platform/installation.md#2-create-admin-account)): it signs
the account up through better-auth in-process and needs neither route below. This command reaches the
engine through two public routes that a default install keeps shut:

1. The account is created through `POST /api/auth/sign-up/email`, which answers
   `403 registration_disabled` unless self-registration is open. Start the engine
   with `ZVELTIO_REGISTRATION_ENABLED=true` for this one step, and restart it
   without the variable afterwards.
2. The `god` role is granted through `POST /api/permissions/bootstrap`, which
   needs `RECOVERY_TOKEN` (32+ characters) set on the engine and the same value
   passed to the CLI. Without it the account is created but stays a `member`.

```bash
RECOVERY_TOKEN=<same value as the engine> zveltio create-god --email admin@company.ro --name "Admin"
zveltio create-god --recovery-token <token> --url https://api.yourapp.com
```

Without a terminal (a provisioning script), pipe the answers one per line, in
the order asked: `yes` to the warning, then the password twice (the email and
name too, unless given as options):

```bash
printf 'yes\n%s\n%s\n' "$PW" "$PW" | RECOVERY_TOKEN=<token> zveltio create-god --email admin@company.ro --name "Admin"
```

| Option | Default | Description |
|--------|---------|-------------|
| `--url <url>` | `http://localhost:3000` | Engine URL |
| `--email <email>` | *(prompted)* | Admin email |
| `--name <name>` | *(prompted)* | Admin display name |
| `--recovery-token <token>` | `RECOVERY_TOKEN` | The engine's recovery token |

The password is always prompted, so the command needs a terminal. The token is
spent by the grant: rotate `RECOVERY_TOKEN` (or unset it) afterwards. The god user
bypasses all permission checks. Day-to-day administrators are invited from Studio
by the god account, which does not need self-registration.

---

### `zveltio generate-types [collection]`

Generate TypeScript type definitions for your collections. Useful for type-safe SDK usage.

```bash
# Generate types for all collections
zveltio generate-types

# Generate types for a specific collection
zveltio generate-types products

# Custom output path
zveltio generate-types --output ./src/types/zveltio.d.ts

# From the schema files (`zveltio schema pull`), no engine needed
zveltio generate-types --from schema/
```

| Option | Default | Description |
|--------|---------|-------------|
| `-o, --output <path>` | `./types/zveltio.d.ts` | Output file path |
| `--url <url>` | `http://localhost:3000` | Engine URL |
| `--from <dir>` | — | Read `<dir>/collections/*.json` instead of asking an engine. Same generator as the engine (`@zveltio/sdk/codegen`); a field type that is not a core type (an extension's) is typed `any`. |

Generated file example:

```typescript
// zveltio.d.ts
export interface Products {
  id: string;
  title: string;
  price: number;
  created_at: string;
}
```

---

### `zveltio login` / `zveltio logout`

Sign the CLI in to an engine as your user. The marketplace commands below need it.

```bash
zveltio login --url https://console.example.com
zveltio logout --url https://console.example.com
```

`login` asks for your email, password and, when the account has one, the code from your authenticator app. Without a terminal, pipe the answers one per line: email (unless `--email`), password, then the code. The CLI keeps the session the engine issues, never the password, in `$XDG_CONFIG_HOME/zveltio/credentials.json` (default `~/.config`, mode 0600), one per engine. The CLI sends a session over `http://` only to `localhost`; any other engine must be `https://`. Signing in again ends the previous session. `logout` ends the session on the engine and removes it from the file, and exits non-zero if the engine did not confirm.

Every marketplace change (install, enable, disable, update) then asks for a fresh authenticator code, the same confirmation the Console asks for. One code confirms one change, so `install`, which installs and then enables, asks twice. Pass `--totp <code>` to give the first code on the command line. A terminal cannot use a passkey, so an account that confirms with a passkey only confirms each change in the browser instead: the CLI prints a short code and a link to the Console (`/admin/cli-sign-in`), opens it, and waits. Check that the code matches, then approve with your passkey or authenticator app. Each request expires after ten minutes and is used once.

`zveltio login --web` signs in the same way, through the Console, instead of asking for a password. When `ZVELTIO_CONSOLE_HOST` is set, give the console host as `--url`: the marketplace and the browser confirmation answer only there. Set `ZVELTIO_NO_BROWSER=1` to only print the link (on a server without a browser, open it on another machine).

---

### `zveltio install <name>`

Install an extension from the marketplace or a local path. The marketplace flow needs `zveltio login`.

```bash
# Install from marketplace
zveltio install ai

# Install your own signed extension from a local directory
zveltio install acme/invoices --path ./acme-invoices

# Force overwrite existing
zveltio install acme/invoices --path ./acme-invoices --force
```

`--path` copies the directory to `<EXTENSIONS_DIR>/<name>` (`./extensions` when
`EXTENSIONS_DIR` is unset), where `<name>` is the manifest's, `category/name` or
a single segment, and must match the one given. The directory must be signed
(`zveltio extension sign`); the signature is verified before the copy and again
on the copy, against `OPERATOR_PUBLIC_KEYS_JSON` when this shell has it, else
your own key in `~/.zveltio/keys`. The engine verifies it once more at every
load, against its own `OPERATOR_PUBLIC_KEYS_JSON`. Then enable it with
`zveltio extensions enable <name>`: the marketplace lists a directory in
`EXTENSIONS_DIR` though no catalogue names it — signed, with its key; unsigned or
with a signature that does not hold, with why it cannot be enabled — and listing
it in `ZVELTIO_EXTENSIONS` instead loads it active for no tenant (`extensions
list` shows it installed, not active).

| Option | Default | Description |
|--------|---------|-------------|
| `--path <path>` | — | Install a signed directory of your own (offline) |
| `--url <url>` | `http://localhost:3000` | Engine URL |
| `--force` | — | Overwrite existing extension |
| `--totp <code>` | — | Authenticator code for the first confirmation (asked for otherwise) |

---

### `zveltio extensions list`

List all available and installed extensions.

```bash
zveltio extensions list
zveltio extensions list --category ai
zveltio extensions list --json
```

| Option | Default | Description |
|--------|---------|-------------|
| `--url <url>` | `http://localhost:3000` | Engine URL |
| `--category <category>` | — | Filter by category |
| `--json` | — | Output as JSON |

---

### `zveltio extensions enable <name>`

Enable an installed extension (hot-loads if supported, otherwise requires restart).

```bash
zveltio extensions enable ai
```

`enable`, `disable`, `update` and `install` are step-up actions: the account must
have an enrolled second factor (an authenticator app or a passkey), on a local
development instance too. An account without one is refused with
`step_up_enrollment_required`. The CLI cannot enroll a factor: enroll it in Studio
(account settings), then run `zveltio login` again, because turning two-factor on
ends every other session, the CLI's included.

---

### `zveltio extensions disable <name>`

Disable an active extension.

```bash
zveltio extensions disable ai
```

---

### `zveltio extensions update <name>`

Update an installed extension to the version the registry serves. `extensions list` marks the ones with an update. Only an extension installed from the registry can be updated, and only forward.

```bash
zveltio extensions update crm
```

`enable`, `disable` and `update` take `--url <url>` and `--totp <code>`.

---

### `zveltio extension create <name>`

Scaffold a new extension: one declared collection, one action and one `zveltio.view/2` page.

```bash
zveltio extension create my-feature
zveltio extension create my-feature --category compliance
```

| Option | Default | Description |
|--------|---------|-------------|
| `--category <category>` | `custom` | Extension category |

Creates:

```
extensions/custom/my-feature/
├── manifest.json
├── schema/collections/<collection>.json   the declared collection
├── engine/index.ts                        the action
├── studio/schemas/my-feature.json         the view/2 page
├── studio/messages/en.json
├── package.json                           only outside a Zveltio checkout: pins @zveltio/sdk
├── .gitattributes
└── .github/workflows/ci.yml
```

Outside a checkout the scaffold pins `@zveltio/sdk` to the CLI's own version. A
pre-release CLI can name an SDK version npm does not have yet; point the
dependency at a local checkout (`"@zveltio/sdk": "file:../zveltio/packages/sdk"`)
until it is published. The package resolves to its built `dist/`, so build the
checkout first (`bun run --cwd=../zveltio/packages/sdk build`), then
`bun install` in the extension folder.

See [extensions/authoring.md](../extensions/authoring.md) for what goes in each file.

---

### `zveltio extension pack`

Bundle `engine/index.ts` into `engine/index.js` and write the `engine` and
`integrity` blocks into `manifest.json`.

```bash
cd extensions/custom/my-feature
zveltio extension pack
```

Without `--first-party` the bundle is marked `isolation: "worker"`. `extension build`
is a deprecated alias for `pack`.

---

### `zveltio extension sign`

Sign an extension directory with your own key, so an engine that trusts the key
loads it at level 3, private: on the extension runner, never inline (ADR 0056).
Pack it first (`isolation: "worker"`, bundled) and sign again after any change.

```bash
zveltio keys generate --id my-org-2026
zveltio extension sign --dir ./acme-invoices --key-id my-org-2026
zveltio keys export my-org-2026   # the entry for the engine's OPERATOR_PUBLIC_KEYS_JSON
```

It writes `signature.json` at the directory's root: an Ed25519 signature over
every file in the directory, its name and the tier `private`. A level-3
extension is declared model only: its `register()` may use neither its app nor
its `ctx`, and `engine/migrations/*.sql` is refused. `extension publish` leaves
the root `signature.json` out of its archive. See
[signatures](../extensions/signatures.md#your-own-extensions-level-3).

---

### `zveltio extension validate`

Pre-publish checks: manifest schema, dependency allow-list, bundle quota.

---

### `zveltio extension publish`

Validate, pack, archive, sign and upload an extension to the registry.

```bash
zveltio extension publish --token <registry-token>
zveltio extension publish --output ./dist   # local only: write .zvext + .sig, no upload
```

| Option | Description |
|--------|-------------|
| `--token <token>` | Registry token (env `ZVELTIO_REGISTRY_TOKEN`) |
| `--registry-url <url>` | Registry base URL (env `ZVELTIO_REGISTRY_URL`) |
| `--key-id <id>` | Signing key (default: the only key in `~/.zveltio/keys/`) |
| `--output <dir>` | Local-only mode |
| `--dry-run` | Validate, pack and build; no archive, signature or upload |

Signing keys come from `zveltio keys generate`.

---

### `zveltio version`

Display the current Zveltio CLI and engine version.

```bash
zveltio version
```

---

### `zveltio update`

Update Zveltio to the latest version.

```bash
zveltio update
```

---

## Common Workflows

### First-time setup

```bash
git clone https://github.com/your-org/zveltio.git
cd zveltio
bun install
cp .env.example .env
# Edit .env with your database credentials
docker compose up -d db pooler cache storage
zveltio migrate
zveltio create-god
zveltio dev
```

### Production deploy

```bash
zveltio migrate          # Run pending migrations
zveltio start            # Start in production mode
```

### Add a new extension

```bash
zveltio install ai
# Add to ZVELTIO_EXTENSIONS in .env
zveltio dev              # Restart to load
```
