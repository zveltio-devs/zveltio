# 📚 Zveltio Documentation

Welcome to the Zveltio documentation. This directory contains comprehensive guides for all aspects of the platform.

---

## 📋 Table of Contents

### Getting Started

- [Quick Start](../README.md#-quick-start) - Fastest way to get running
- [Installation Guide](INSTALLATION.md) - Detailed setup instructions
- [Configuration Guide](CONFIGURATION.md) - Environment variables and options

### Core Concepts

- [Architecture](ARCHITECTURE.md) - System design and component overview
- [Authentication](AUTHENTICATION.md) - Better-Auth setup and configuration
- [Authorization](AUTHORIZATION.md) - RBAC with Casbin and Emergency Admin Access
- [Dynamic Collections](COLLECTIONS.md) - Schema-less database tables

### Features

- [AI Integration](AI.md) - Universal AI providers and features
- [GraphQL API](GRAPHQL.md) - Auto-generated read-only GraphQL (queries + relations)
- [Webhooks](WEBHOOKS.md) - Event-driven integrations
- [Export System](EXPORT.md) - PDF, Excel, CSV generation
- [Extensions](EXTENSIONS.md) - Plugin system

### Operations

- [Deployment](DEPLOYMENT.md) - Production deployment with Docker
- [Monitoring](MONITORING.md) - Prometheus and Grafana setup
- [Security](SECURITY.md) - Security best practices
- [Troubleshooting](TROUBLESHOOTING.md) - Common issues and solutions

---

## 🎯 Quick Links

### For Users

- [Studio User Guide](../packages/studio/) - Admin interface documentation
- [SDK Documentation](../packages/sdk/) - Client-side integration

### For Developers

- [CLI Commands](../packages/cli/src/commands/) - Available commands
- [API Reference](../packages/engine/src/routes/) - REST API endpoints
- [Type Definitions](../packages/sdk/src/types/) - TypeScript types

### For DevOps

- [Docker Compose](../docker-compose.yml) - Infrastructure configuration
- [Environment Variables](../.env.example) - Configuration options

---

## 📁 Documentation Structure

```
docs/
├── INSTALLATION.md      # Detailed installation guide
├── CONFIGURATION.md     # Environment configuration
├── ARCHITECTURE.md      # System architecture
├── AUTHENTICATION.md    # Auth setup
├── AUTHORIZATION.md     # RBAC and permissions
├── COLLECTIONS.md       # Dynamic collections
├── AI.md               # AI integration
├── GRAPHQL.md          # GraphQL API (read-only)
├── WEBHOOKS.md         # Webhook system
├── EXPORT.md           # Export functionality
├── EXTENSIONS.md        # Plugin system
├── DEPLOYMENT.md       # Production deployment
├── MONITORING.md       # Monitoring setup
├── SECURITY.md         # Security hardening
└── TROUBLESHOOTING.md  # Common issues
```

---

## 🔗 External Resources

- [GitHub Repository](https://github.com/zveltio/zveltio)
- [Issues](https://github.com/zveltio/zveltio/issues)
- [Discussions](https://github.com/zveltio/zveltio/discussions)

---

## 💬 Support

For questions or issues, please:

1. Check the [Troubleshooting Guide](TROUBLESHOOTING.md)
2. Search existing [GitHub Issues](https://github.com/zveltio/zveltio/issues)
3. Open a new issue if needed
