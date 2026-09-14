# Zveltio — Claude Code session rules

This file is loaded automatically at the start of every session. `AGENTS.md` is
**not** — Claude Code discovers `CLAUDE.md`, and reads `AGENTS.md` only when
something points at it.

**So: read `AGENTS.md` first.** Repository layout, the quality gates, the
commands and the conventions live there. This file does not repeat them, on
purpose — every line here is paid for in every session, forever.

## Working across the two repositories

First-party extensions are a sibling checkout at `../zveltio-extensions`.

- Do not `cd` between them — use `bun --cwd ../zveltio-extensions <command>`.
- Several gates read that sibling through a hardcoded relative path, so a
  command run from the wrong directory measures the wrong tree and reports a
  confident, wrong answer.

## Two habits this codebase keeps paying for

- **Verify the artifact, not the command's output.** `extension pack` prints
  `✓ pack complete` whether or not the bundle changed; a gate reports what it
  looked at, which is not always what you think it looked at.
- **Keep tool output small.** Pass `-q` / `--silent`, or pipe through `head`.
  A command whose output you truncate is cheaper than one you re-run.
