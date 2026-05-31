# CLI Reference

The `zveltio` command-line tool for managing your Zveltio instance.

## Installation

The CLI is included in the engine package. After cloning the repository:

```bash
bun install
bun run packages/cli/src/index.ts --help
```

Or install globally:

```bash
bun add -g zveltio
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

Migrations are applied in order from `packages/engine/src/db/migrations/sql/`. Already-applied migrations are skipped. Always run this after pulling new code or enabling new extensions.

---

### `zveltio rollback`

Roll back the last applied migration.

```bash
zveltio rollback
```

> Use with caution in production — rollbacks may be destructive if the migration dropped or renamed columns.

---

### `zveltio create-god`

Create the first super-admin (god) user interactively. Only needed once after initial setup.

```bash
zveltio create-god
zveltio create-god --email admin@company.ro --name "Admin"
zveltio create-god --url https://api.yourapp.com
```

| Option | Default | Description |
|--------|---------|-------------|
| `--url <url>` | `http://localhost:3000` | Engine URL |
| `--email <email>` | *(prompted)* | Admin email |
| `--name <name>` | *(prompted)* | Admin display name |

The god user bypasses all permission checks and cannot be locked out. Store credentials securely.

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
```

| Option | Default | Description |
|--------|---------|-------------|
| `-o, --output <path>` | `./zveltio.d.ts` | Output file path |
| `--url <url>` | `http://localhost:3000` | Engine URL |

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

### `zveltio install <name>`

Install an extension from the marketplace or a local path.

```bash
# Install from marketplace
zveltio install ai

# Install from local directory
zveltio install my-extension --path ./extensions/my-extension

# Force overwrite existing
zveltio install my-extension --path ./extensions/my-extension --force
```

| Option | Default | Description |
|--------|---------|-------------|
| `--path <path>` | — | Install from local directory (offline) |
| `--url <url>` | `http://localhost:3000` | Engine URL |
| `--force` | — | Overwrite existing extension |

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

---

### `zveltio extensions disable <name>`

Disable an active extension.

```bash
zveltio extensions disable ai
```

---

### `zveltio extension create <name>`

Scaffold a new extension with the correct directory structure.

```bash
zveltio extension create my-feature
zveltio extension create my-feature --category compliance
```

| Option | Default | Description |
|--------|---------|-------------|
| `--category <category>` | `custom` | Extension category |

Creates the following structure:

```
extensions/custom/my-feature/
├── manifest.json
├── engine/
│   ├── index.ts
│   ├── routes.ts
│   └── migrations/
└── studio/
    ├── package.json
    └── src/
        └── index.ts
```

---

### `zveltio extension build`

Build the current extension into a `.zvext` bundle for marketplace publishing.

```bash
cd extensions/my-category/my-extension
zveltio extension build
```

---

### `zveltio extension publish`

Publish an extension to the Zveltio marketplace.

```bash
zveltio extension publish --token your-marketplace-token
```

| Option | Description |
|--------|-------------|
| `--token <token>` | Marketplace authentication token (from developer.zveltio.com) |

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
