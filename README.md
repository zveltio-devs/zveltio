# Zveltio

The BaaS that just works.

## Quick Start

```bash
# Download & install
curl -fsSL https://get.zveltio.com | sh

# Start with an existing PostgreSQL
zveltio start --db postgresql://user:pass@localhost/mydb

# Open admin interface
open http://localhost:3000/admin
```

## What is Zveltio?

A complete Backend-as-a-Service in a single binary. No Docker required, no complex setup, no microservices to manage.

- **Engine** — REST API, auth, permissions, real-time
- **Studio** — Admin interface, responsive, works on mobile
- **Extensions** — Install additional features with one click

## Architecture

```
zveltio/
├── packages/
│   ├── engine/    # Bun + Hono backend, compiles to single binary
│   ├── studio/    # SvelteKit admin UI, embedded in engine at /admin
│   ├── sdk/       # @zveltio/sdk for client apps
│   └── cli/       # @zveltio/cli development tools
└── extensions/    # Optional feature extensions
    ├── workflow/
    ├── ai/
    ├── content/
    ├── automation/
    ├── developer/
    ├── geospatial/
    └── compliance/
```

## Development

```bash
# Install dependencies
pnpm install

# Start all packages in dev mode
pnpm dev

# Build everything
pnpm build

# Build single binary
pnpm build:binary
# Output: dist/zveltio (single executable)
```

## Extensions

Extensions add optional functionality to Zveltio. They are loaded at startup based on the `ZVELTIO_EXTENSIONS` environment variable.

```bash
# Enable extensions in .env
ZVELTIO_EXTENSIONS=workflow/approvals,ai/core-ai,content/page-builder

# Or create a custom extension
zveltio extension create my-extension

# Build extension
zveltio extension build

# Publish to marketplace
zveltio extension publish
```

## Environment Variables

See `.env.example` for all available configuration options.

## License

MIT
