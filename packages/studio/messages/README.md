# Studio UI messages (Paraglide)

## Source of truth (edit these)

| Location | Contents |
|----------|----------|
| `messages/core/{locale}.json` | Shared Studio UI: `common.*`, `nav.*`, `shell.*`, `auth.*`, … |
| `zveltio-extensions/<ext>/studio/messages/{locale}.json` | Strings for that extension only |

Locales: **en**, **ro**, **fr**, **de**, **es**, **it**, **nl**, **pl**, **hu**
(`baseLocale`: en). All nine, with identical key sets.

## Generated (do not edit by hand)

| File | Produced by |
|------|-------------|
| `messages/{locale}.json` (the merged bundle) | `bun run i18n:merge` |
| `src/lib/paraglide/` | `bun run i18n:compile` |
| `packages/sdk/src/validate/shared-message-keys.ts` | `bun run scripts/sync-shared-message-keys.ts` (repo root) |

Then: `bun run i18n:compile` (runs merge automatically).

**Editing `messages/{locale}.json` directly does nothing** — the next merge
overwrites it. The tell is the key count dropping after a compile. Edit
`messages/core/` or the extension's own catalogue instead.

## New extension

1. Add `studio/messages/en.json` plus the other eight locales.
2. Namespace keys by extension id, e.g. `finance.quotes.title` for `finance/quotes`.
3. Reuse `common.*` / `ext.*` rather than minting your own "Save" — see
   `shared-message-keys.ts` for the list.
4. Never use another extension's keys, and never leave your own text in
   `messages/core/`: an extension whose translations live in the host renders
   correctly only on a host that already knows about it.
5. Run `bun run i18n:compile` from `packages/studio`.

Full rules, including what `zveltio extension validate` enforces:
[EXTENSION-DEVELOPER-GUIDE §10.5](../../../docs/extensions/developer-guide.md#105-translating-your-extension).

## Gates

| Check | Runs | Catches |
|-------|------|---------|
| `scripts/check-i18n-core.ts` | CI (zveltio) | Hardcoded text on translated core pages, **and any `m['key']` that resolves nowhere** — an unknown key is `undefined`, so calling it throws and blanks the page. |
| `zveltio extension validate` | CI (zveltio-extensions) | SDUI schema strings that are not real keys, plus hardcoded schema text (warning). |
| `check:shared-keys` | CI (zveltio) | The SDK's generated copy of `common.*` + `ext.*` drifting from this catalogue. |

Missing keys in a non-`en` locale fall back to English at merge time — so a
locale that is merely incomplete degrades gracefully. A key that exists in *no*
catalogue does not: it reaches the user as the raw key string, or crashes the
page. That is the difference the gates exist to police.
