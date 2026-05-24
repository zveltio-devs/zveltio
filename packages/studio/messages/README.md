# Studio UI messages (Paraglide)

## Source of truth (edit these)

| Location | Contents |
|----------|----------|
| `messages/core/{locale}.json` | Shared Studio UI: `common.*`, `nav.*`, `shell.*`, `auth.*`, … |
| `zveltio-extensions/<ext>/studio/messages/{locale}.json` | Strings for that extension only |

Locales: **en**, **ro**, **fr**, **de** (`baseLocale`: en).

## Generated (do not edit by hand)

| File | Produced by |
|------|-------------|
| `messages/en.json`, `ro.json`, `fr.json`, `de.json` | `bun run i18n:merge` |

Then: `bun run i18n:compile` (runs merge automatically).

## New extension

1. Add `studio/messages/en.json` (and `ro.json`, `fr.json`, `de.json` — copy from `en` until translated).
2. Use keys namespaced by extension id, e.g. `finance.quotes.title` for `finance/quotes`.
3. Run `bun run i18n:compile` from `packages/studio`.

Missing keys in `fr`/`de` fall back to English at merge time.
