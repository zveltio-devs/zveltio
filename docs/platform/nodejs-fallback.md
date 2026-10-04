# Runtime support: Bun only

Zveltio runs on **Bun**. Node.js and Deno are **not supported** runtimes for the
engine.

This page used to describe a Node.js 22 fallback "with minimal changes". That
fallback was never tested, and it does not hold. The engine calls Bun's own APIs
directly in about 55 source files:

| API | Files |
|---|---|
| `Bun.file` | 18 |
| `Bun.SQL` | 15 |
| `Bun.serve` | 8 |
| `Bun.spawn` | 8 |
| `Worker` (Bun workers) | 4 |
| `Bun.Glob` | 2 |

The compiled release binary also embeds the Bun runtime. Porting all of this is
a project, not a configuration change. Nothing in CI tests it, so this page
does not promise it.

## Why Bun

- TypeScript runs natively, with no build step for the engine.
- `Bun.serve`, `Bun.file` and Bun's WebSocket and subprocess APIs are used
  directly.
- One toolchain covers install, test and single-binary builds
  (`bun build --compile`).

## If your organisation cannot approve Bun

- **Use the release binary or the Docker image.** Bun is embedded in both, so
  no separate Bun installation is needed on the host.
- If a policy still rules Bun out, open an issue describing the constraint.
  Runtime support is a product decision; it would be planned, not patched in.
