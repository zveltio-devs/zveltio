# Alpha track end-of-life (EOL)

**Effective:** `1.0.0-beta.1` (2026-05-31)  
**Last alpha release:** [`v1.0.0-alpha.129`](https://github.com/zveltio-devs/zveltio/releases/tag/v1.0.0-alpha.129)  
**Current supported line:** **`3.0.0-beta.x`** — install or upgrade to the [latest beta release](https://github.com/zveltio-devs/zveltio/releases/latest).

---

## Summary

The **alpha track is closed**. We will not publish new `1.0.0-alpha.*` tags. All engineering effort is on **beta** toward **v1.0.0**.

Alpha releases **remain on GitHub** (tags + release assets) for reproducibility, migration, and audit. We are **not** deleting alpha history.

---

## What you should do

| If you are on… | Action |
|----------------|--------|
| **Nothing installed yet** | Install beta only: `curl -fsSL https://get.zveltio.com/install.sh \| bash` or `zveltio update --version 3.0.0-beta.7` |
| **`1.0.0-alpha.111` or newer** | Upgrade to latest beta; DB migrates on startup. See [MIGRATION-ALPHA-TO-BETA.md](./MIGRATION-ALPHA-TO-BETA.md) |
| **`1.0.0-alpha.110` or older** | Plan a maintenance window — extension manifests and bundled layout differ; migration is **one-way** to beta |
| **Pinned to a specific alpha in CI** | Unpin; move CI to `3.0.0-beta.7` (or `@latest` beta from [get.zveltio.com/latest.json](https://get.zveltio.com/latest.json)) |

```bash
# Recommended upgrade path
zveltio update --version 3.0.0-beta.7
# or, if you use the installer channel:
curl -fsSL https://get.zveltio.com/install.sh | bash
```

After upgrade, re-pack or re-install official extensions if `zveltio extension validate` reports v1 manifests or missing `engine/index.js` bundles.

---

## Support policy

| Line | Status |
|------|--------|
| **`1.0.0-alpha.*`** | **EOL** — no new features; no guarantee of fixes except critical security issues discovered in shared code still present in beta |
| **`3.0.0-beta.x`** | **Active** — supported pre-1.0 line; extension manifest v2 + marketplace API stable per [README Beta caveats](../README.md#beta-caveats) |
| **`1.0.0` (stable)** | Target GA — not shipped yet |

Report issues on [GitHub Issues](https://github.com/zveltio-devs/zveltio/issues). When reporting from an alpha install, include the exact tag (e.g. `alpha.129`) and upgrade to beta first if possible.

---

## Why beta replaces alpha

Beta.1 closed Extensions v2 on the compiled binary (bundled `engine/index.js`, integrity verification, worker isolation for community code, marketplace review queue). That model is **API-stable** through v1.0. Alpha was the fast iteration lane for the same goals; keeping two pre-release tracks would split testing and documentation.

**Beta.2** adds marketplace admin team (`/admin/team` on apps.zveltio.com) — still on the beta line, not alpha.

---

## Paste into GitHub Release (`v1.0.0-beta.1`)

Use this block at the top of the beta.1 release notes (edit version if needed):

```markdown
### Alpha track closed

**`1.0.0-alpha.*` is end-of-life** as of this release. The last alpha tag is
[`v1.0.0-alpha.129`](https://github.com/zveltio-devs/zveltio/releases/tag/v1.0.0-alpha.129).
Alpha releases stay on GitHub for history; we will not ship new alpha versions.

**Upgrade:** `zveltio update --version 3.0.0-beta.7` (or latest beta from
https://get.zveltio.com/latest.json).

**Docs:** [Alpha track EOL](https://github.com/zveltio-devs/zveltio/blob/master/docs/ALPHA-TRACK-EOL.md) ·
[Migration guide](https://github.com/zveltio-devs/zveltio/blob/master/docs/MIGRATION-ALPHA-TO-BETA.md)
```

---

## Related

- [MIGRATION-ALPHA-TO-BETA.md](./MIGRATION-ALPHA-TO-BETA.md) — env vars, migrations, extension repack
- [MARKETPLACE-POLICY.md](./MARKETPLACE-POLICY.md) — controlled launch during beta
- [CHANGELOG.md](../CHANGELOG.md) — full release history
