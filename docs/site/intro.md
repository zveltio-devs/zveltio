# Zveltio Documentation

> **Status: 3.0.0-beta.12** — extensions platform + marketplace are
> API-stable. Engine internals + Studio still iterating toward v1.0.
> See [Beta caveats](https://github.com/zveltio-devs/zveltio#beta-caveats) for what's locked vs. still moving.
>
> **Alpha track EOL:** `1.0.0-alpha.*` is closed (last: alpha.129). New installs
> should use beta only — see
> [Alpha track EOL](https://github.com/zveltio-devs/zveltio/blob/master/docs/ALPHA-TRACK-EOL.md).

Zveltio is a self-hosted **Business OS** — not just a BaaS, but a complete operating layer for your business. Data, API, CRM, automation, compliance, AI, and real-time sync — all in a single binary that runs on a €20 VPS.

Unlike Supabase, Appwrite, or Directus — which stop at the backend layer — Zveltio ships a full business stack that no competitor offers in a single binary:

- **Environment branching** — branch your entire database schema like Git (dev → staging → production)
- **AI schema generation** — describe your app in plain English, get collections, relations, and permissions
- **Bring Your Own Database** — connect an existing PostgreSQL database, Zveltio auto-generates the admin UI and API
- **Zero-downtime DDL** — alter 5M-row tables while users are active, no locks, no maintenance windows
- **Per-field encryption** — mark any field `encrypted: true`; AES-256-GCM transparent at the engine level
- **Live TypeScript types** — run `zveltio generate-types` once; every SDK call is typed from that point on
- **Immutable audit trail** — every write logged with user, IP, before/after values; GDPR export built in
- **Extensions marketplace** — AI, CRM, mail, flows, compliance (e-Factura, SAF-T RO), geospatial, billing, and more

---

## Table of Contents

### Getting Started

- [Installation Guide](/installation) - Detailed setup instructions
- [Deployment](/deployment) - Production deployment with Docker
- [Configuration](/configuration) - Environment variables and options
- [CLI Reference](/cli) - Available CLI commands
- [Troubleshooting](/troubleshooting) - Common issues and solutions

### Architecture

- [Architecture](/architecture) - System design and component overview
- [Ecosystem](/ecosystem) - Platform overview and integrations
- [Ghost DDL](/ghost-ddl) - Zero-downtime schema migrations
- [Horizontal Scaling](/horizontal-scaling) - HA and enterprise scaling
- [Monitoring](/monitoring) - Prometheus and Grafana setup

### Core Features

- [Collections](/collections) - Dynamic schema with 20+ field types
- [AI Schema Generation](/self-hosted-ai) - Natural language to database schema (covered in self-hosted AI guide)
- [Bring Your Own Database](/collections) - Introspect and manage existing Postgres (see Collections + BYOD section)
- [Per-Field Encryption](/security) - AES-256-GCM transparent field-level encryption
- [Audit Trail](/security) - Immutable audit log and GDPR export
- [Extensions](/extensions) - Plugin system and marketplace
- [Webhooks](/webhooks) - Event-driven integrations
- [GraphQL](/graphql) - Auto-generated GraphQL API with mutations, persisted queries, and playground (via `developer/graphql` extension)

### SDK & API

- [API Reference](/api-reference) - REST API endpoints
- [SDK Reference](/sdk) - TypeScript SDK with live types
- [Authentication](/authentication) - Better-Auth setup and configuration
- [Authorization](/authorization) - RBAC with Casbin (row and column-level)
- [Security](/security) - Hardening, encryption, rate limiting
- [Node.js 22 Fallback](/nodejs-fallback) - Fallback runtime configuration

---

## How It Compares

| Feature | Zveltio | Supabase | Appwrite | Directus |
|---|---|---|---|---|
| Self-hosted | Yes | Yes | Yes | Yes |
| Zero-downtime DDL | Yes | No | No | No |
| Environment branching | Yes | No | No | No |
| AI schema generation | Yes | No | No | No |
| Bring Your Own DB | Yes | No | No | Partial |
| Per-field encryption | Yes | No | No | No |
| Single binary | Yes | No | No | No |
| CRM built-in | Yes | No | No | No |
| Automation / Flows | Yes | No | No | No |
| Compliance (e-Factura, SAF-T) | Yes | No | No | No |
| Extensions marketplace | Yes | No | No | Partial |

---

## Support

For questions or issues:

1. Check the [Troubleshooting Guide](/troubleshooting)
2. Search existing [GitHub Issues](https://github.com/zveltio-devs/zveltio/issues)
3. Open a new issue if needed
