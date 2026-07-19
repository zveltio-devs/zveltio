# Archived one-off codemods

These scripts were single-use migrations (the i18n externalization waves, the
ConfirmModal migration, nav-group manifest patching, page-corruption repairs)
run during alpha/beta and already applied — their output is committed. They are
kept for archaeology, not for running: re-running them against today's tree
would at best no-op and at worst re-corrupt migrated pages.

Live tooling stays in `scripts/`: `sync-extensions.ts`,
`merge-extension-messages.ts` (+ `lib/`), wired via package.json
`predev`/`prebuild`/`i18n:merge`.
