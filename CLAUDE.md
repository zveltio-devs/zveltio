# Claude Code Session Rules - Zveltio Engine

## Execution & Directory Rules (Token Preservation)
- **Root Context:** Workspace root is `/home/liviu/zveltio`.
- **No `cd` Churn:** NEVER prepend `cd /home/liviu/...` or switch directories before executing Bash commands.
- **Cross-Repo Commands (`zveltio-extensions`):** First-party extensions live in `../zveltio-extensions`. 
  - Do NOT `cd` into `../zveltio-extensions`.
  - Always use Bun's workspace flag: `bun --cwd ../zveltio-extensions <command>`.
  - Example: `bun --cwd ../zveltio-extensions test`
- **Output Limits:** Pass flags like `-q`, `--silent`, or limits (`head -n 20`) to keep tool output payloads small.

## Deep Context Reference
- For full architecture, tech stack, and contribution guidelines, read `AGENTS.md`.