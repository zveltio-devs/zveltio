# Zveltio Documentation

The single, unified documentation set for Zveltio. Everything here is organised
into five chapters. Start with the chapter that matches what you are about to
change; each chapter opens with its own index.

**Version:** `3.0.0-beta.64` — source of truth is `packages/engine/package.json`.
**License:** MIT. **Runtime:** Bun (not Node).

> If you are an AI agent or a new contributor about to touch code, read
> [`../AGENTS.md`](../AGENTS.md) first — it is the short operational map of the
> repository (layout, commands, gates, footguns). This directory is the long form.

---

## The five chapters

| # | Chapter | What it covers | Start here |
|---|---------|----------------|-----------|
| 1 | [**Platform**](platform/) | What Zveltio is, why it is shaped this way, architecture, install, configuration, multi-tenancy, security, operations, development workflow, known gaps | [platform/README.md](platform/README.md) |
| 2 | [**Engine**](engine/) | The Bun/Hono server: routes, data layer, auth, subsystems, SDK and CLI | [engine/README.md](engine/README.md) |
| 3 | [**Studio**](studio/) | The SvelteKit 5 admin application served at `/admin` | [studio/README.md](studio/README.md) |
| 4 | [**UI**](ui/) | Design system, component library, interaction patterns, SDUI renderer | [ui/README.md](ui/README.md) |
| 5 | [**Extensions**](extensions/) | The extension system and the 56 official extensions | [extensions/README.md](extensions/README.md) |

Supporting material:

- [`adr/`](adr/) — architecture decision records.
- [`legal/`](legal/) — terms of service and privacy policy (published to the website).
- [`private/`](private/) — internal engineering plans that are referenced from
  source code and must keep stable paths. Not user documentation. See
  [private/README.md](private/README.md).
- [`manifest-v2.schema.json`](manifest-v2.schema.json) — JSON Schema for the
  extension manifest.

---

## Reading order by role

**Operator — I need to run this in production.**
[Overview](platform/overview.md) → [Installation](platform/installation.md) →
[Configuration](platform/configuration.md) → [Operations](platform/operations.md) →
[Security](platform/security.md) → [Disaster recovery](platform/disaster-recovery.md)

**Taking over the project.**
[Overview](platform/overview.md) → [History](platform/history.md) — why it is
shaped this way → [Architecture](platform/architecture.md) →
[Development](platform/development.md) → [Known gaps](platform/known-gaps.md)

**Backend contributor — I am changing the engine.**
[`AGENTS.md`](../AGENTS.md) → [Engine](engine/README.md) →
[Multi-tenancy](platform/multi-tenancy.md) → [Development](platform/development.md)

**Frontend contributor — I am changing the admin UI.**
[Studio](studio/README.md) → [UI design system](ui/README.md) →
[UI patterns](ui/patterns.md)

**Extension author — I am building a plugin.**
[Extensions](extensions/README.md) → [Developer guide](extensions/developer-guide.md) →
[Cookbook](extensions/cookbook.md) → [Marketplace policy](extensions/marketplace-policy.md)

**Auditor / reviewer — I am assessing this system.**
[Security](platform/security.md) (threat model and prior-round corrections) →
[Multi-tenancy](platform/multi-tenancy.md) →
[Audit coverage](platform/audit-coverage.md) → [Known gaps](platform/known-gaps.md)

---

## How this documentation is maintained

**One source, two audiences.** These files are both the engineering
documentation and the source for the public site at `zveltio.com`. The website
repository (`zveltio-website`) syncs a selected subset of these files at build
time via `scripts/sync-docs.mjs` and routes them by slug in `src/lib/config.ts`.
Pages that ship to the website are listed in that script's manifest — adding a
public page means adding it in both places.

**Rules for published pages.** Files synced to the website are rendered by
mdsvex with flat slug routing, so within them:

- Link with site slugs (`[Installation](platform/installation.md)`), not relative paths.
- Keep fenced code blocks under ~30 lines; long blocks overflow the prose column.
- Do not reference images unless they also exist in `zveltio-website/static/`.

Chapter files that are *not* published (engine internals, UI patterns, known
gaps) use ordinary relative links and have no such constraints.

**Accuracy rule.** Documentation that disagrees with the code is a defect, not a
style issue. Two things in this tree are enforced mechanically:

- `platform/configuration.md` — the `DB_POOL_MAX` row is parsed by
  `packages/engine/src/tests/unit/pool-max-single-source.test.ts`. The
  documented default must equal `DEFAULT_DB_POOL_MAX` in code or the test fails.
- `platform/audit-coverage.md` — read by `scripts/audit-gates.ts` and
  `scripts/audit-inventory.ts`.

Several documents are also cited from source comments and runtime error
messages. Before moving or renaming any file here, run:

```sh
grep -rn "docs/" --include="*.ts" --include="*.svelte" --include="*.sql" \
  --include="*.sh" --include="*.json" --include="*.yml" . | grep -v node_modules
```
