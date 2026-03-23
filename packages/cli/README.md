# @zveltio/cli

Official CLI for [Zveltio](https://zveltio.com) — manage your Zveltio instance from the terminal.

## Installation

```bash
npm install -g @zveltio/cli
# or
bun add -g @zveltio/cli
```

Or run without installing:

```bash
bunx @zveltio/cli init
```

## Commands

### `zveltio init`

Scaffold a new Zveltio project with a `docker-compose.yml` and `.env`:

```bash
zveltio init
```

### `zveltio dev`

Start the engine in development mode with hot reload:

```bash
zveltio dev
```

### `zveltio start`

Start the engine in production mode:

```bash
zveltio start
```

### `zveltio deploy`

Build a Docker image and push it to your registry:

```bash
zveltio deploy --registry ghcr.io/your-org/your-app --tag latest
```

### `zveltio status`

Check the health of your running instance:

```bash
zveltio status
# Engine: running  v1.0.0
# Database: connected
# Cache: connected
# Uptime: 3d 14h 22m
```

### `zveltio migrate`

Run pending database migrations:

```bash
zveltio migrate
```

### `zveltio rollback`

Rollback the last migration batch:

```bash
zveltio rollback
```

### `zveltio update`

Update Zveltio to the latest version:

```bash
zveltio update
```

### `zveltio generate-types`

Generate TypeScript types from your collections schema:

```bash
zveltio generate-types --output ./types/zveltio.d.ts
```

### `zveltio extension install <id>`

Install an extension from the Zveltio marketplace:

```bash
zveltio extension install @zveltio/ai
zveltio extension install @zveltio/crm
```

### `zveltio version`

Print the current CLI and engine version:

```bash
zveltio version
```

## Links

- [Documentation](https://zveltio.com/docs/cli)
- [GitHub](https://github.com/zveltio-devs/zveltio)
