# Interaction Patterns

The conventions that make separate admin screens feel like one product. These
are decisions already made — follow them rather than re-deciding per page.

---

## Modal or dedicated page

| Use | When |
|---|---|
| **Modal** | Creating a new item with a small, focused form (1–6 fields), edited inline, living on the list page. Webhooks, API Keys, Users, Schema Branches, Backups. |
| **Dedicated page** `/<resource>/[id]` | Editing an existing item that has its own tabs, nested resources, or a rich editor. Collections, flows with a step builder, edge functions. |

Rule of thumb: more than six fields, or tabs, or sub-resources → a page.
Drill-down is a navigation, not a popover.

## Modal sizing

daisyUI's `modal-box` takes a `max-w-*` tweak. Pick by content density:

| Class | Use |
|---|---|
| `max-w-md` | Simple form, ≤ 4 fields. The default for create and invite modals. |
| `max-w-2xl` | Multiple sections, helper text, conditional fields. |
| `max-w-3xl` / `4xl` | Preview or split-view — form beside live preview. |

`max-w-sm` is too tight for real inputs. `max-w-lg` overlaps `max-w-md` in
intent — pick one.

---

## Where actions go

| Surface | Convention |
|---|---|
| Page header | Primary action (*New X*) on the right, via `PageHeader` or `CrudListPage`'s `actionLabel` |
| Modal | `Cancel` + `Save`, bottom-right, inside `<div class="modal-action">` |
| Decision modal | Two equal-weight buttons side by side (Approve / Reject) |
| Table row | Hidden until `group-hover` or `focus-within`; right-aligned |
| Settings panel | One `Save` per panel, bottom-right of that panel |

The older inline-per-row save button in Settings was removed; Settings follows
the save-panel pattern.

---

## Tabs

| Pattern | When |
|---|---|
| `.tabs.tabs-bordered` + local state | Sections differ only in content, no separate URLs — Permissions: Matrix / Roles / Hierarchy |
| Query-param tabs (`?tab=schema`) | Sections benefit from deep-linking and the back button — Collections detail: Data / Schema / API / Settings |

Do not mix both in one surface. New tabs default to local state unless there is
a real deep-link case.

---

## Errors

Three shapes. Pick by *who* needs to see *what*.

| Shape | When | Example |
|---|---|---|
| `toast.error(msg)` | A transient action failed. The user triggered it and is watching. | "Failed to delete webhook" |
| Inline `<div class="alert alert-error">` | Validation errors, or page-level state problems — next to the bad input, or at the top of the section. | "Slug must be lowercase" |
| `<EmptyState />`, error variant | A whole list failed to load. Tells the user no data is shown, and why. | "Couldn't load collections — retry" |

**Never fail silently.** Every `catch` either toasts, sets an inline error, or
surfaces an empty state. `console.error(...)` alone is not enough — this is the
UI half of the engine-side rule that a caught error must not be reported as
success.

Denials are a special case: the engine returns *which rule* refused, and
`src/lib/denial.ts` renders that. Show the reason, not a generic "Forbidden".

---

## Validation timing

| When | Behaviour |
|---|---|
| **As the user types** | Cheap format constraints only — slug regex, email shape, number range. Helper text in `text-error` beside the field. |
| **On submit** | Required fields, async server checks such as uniqueness, cross-field rules. Inline alert at the top of the form, or per-field errors. |
| **Never on focus or blur of an untouched input** | Do not yell about empty fields the user has not started filling. Blur validation applies to non-empty values only. |

`SchemaForm` implements this through the schema's `required`, `pattern` and
`validate` options. Hand-rolled forms follow the same timing by hand.

---

## Empty, loading, and first-run

- Every list has an `EmptyState` with an icon, a sentence explaining what the
  thing is *for*, and the primary action. An empty table with no explanation is
  a bug report waiting to happen.
- Use `LoadingSkeleton` where the shape of the result is known, `PageSpinner`
  where it is not. Do not swap a populated table for a spinner on refetch —
  keep the old rows and dim them.
- First-run guidance belongs in the `onboarding` route, not scattered as
  banners.

---

## Permissions in the UI

`PermissionGuard` hides what the user cannot act on. **This is UX, not
security** — the Studio is a client-side SPA with `ssr = false`, and every guard
in it runs on the user's machine. The engine is the boundary. Hiding a button
must never be the only thing preventing an action.

Prefer hiding an unusable control over showing a disabled one, *unless* its
absence would make the page confusing — a disabled control with a tooltip
explaining which permission is missing is better than a mystery gap.

---

## Writing UI text

- Sentence case for labels, buttons and headings. Not Title Case.
- Say what the thing does, not what it is called internally. "Send HTTP
  callbacks when data changes", not "Configure webhook entities".
- Errors name the fix where one exists. "Slug must be lowercase" beats "Invalid
  slug".
- All user-visible strings go through Paraglide. See
  [../studio/i18n.md](../studio/i18n.md) — a hardcoded string is caught by the
  i18n gates.
