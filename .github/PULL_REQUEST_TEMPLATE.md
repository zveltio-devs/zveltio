<!--
Thanks for contributing to Zveltio! Keep PRs focused — one logical change.
See CONTRIBUTING.md for the code rules and commit/PR style.
-->

## What & why

<!-- What does this change, and what problem does it solve? Link issues with "Closes #123". -->

## How it was verified

<!-- The checks you ran. Be specific. -->

- [ ] `bun run typecheck` passes
- [ ] `bun run lint` clean
- [ ] Tests added/updated and passing (`bun test`)
- [ ] For schema/RLS/multi-tenant changes: validated against a real Postgres (not just CI's superuser conn)
- [ ] For extension changes: re-packed the bundle (`zveltio extension pack`) and `validate` passes

## Notes for reviewers

<!-- Anything non-obvious: trade-offs, follow-ups, areas you want eyes on. -->
