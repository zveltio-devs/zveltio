# Chapter 4 — UI

The visual and interaction layer shared by the Studio and the client app: the
design system, the component library, the interaction patterns, and the
server-driven UI renderer.

| Document | Covers |
|---|---|
| This page | Design system: colour, type, density, motion, accessibility |
| [components.md](components.md) | The shared component library and when to use each piece |
| [patterns.md](patterns.md) | Interaction conventions: forms, lists, modals, errors, tabs |
| [sdui.md](sdui.md) | Server-Driven UI — the JSON schema extensions ship instead of Svelte |

**Stack:** Svelte 5 runes · Tailwind 4 · daisyUI 5 · Lucide icons · Layerchart/D3
· TipTap. The design system lives in `packages/studio/src/app.css`; the client
app mirrors it in `packages/client/src/app.css`.

---

## 1. Design tokens

Everything is a CSS custom property, defined per theme on `[data-theme='light']`
and `[data-theme='dark']`. Components consume tokens, never raw colour values.

### Colour

| Token | Role |
|---|---|
| `--color-primary` | The one brand blue. `oklch(0.47 0.15 250)` in light. |
| `--color-secondary` | The same blue, lifted — **not a second hue**. |
| `--color-accent` | The single warm note, for the rare thing that must be noticed and is not an error. |
| `--color-base-100/200/300` | Cards and inputs / the page ground / rules and wells. |
| `--color-base-content` | Body text. |
| `--color-success` / `warning` / `error` | Status. |
| `--color-info` | Teal — deliberately **not** near the brand hue. |
| `--color-brand-tint` | A real pale blue for selected rows, active nav, info banners. |

Three decisions in there are worth carrying, because each was measured rather
than eyeballed:

**Contrast comes from lightness, not saturation.** At hue 250, moving chroma
from 0.15 to 0.21 changed white-on-fill contrast from 6.75:1 to 6.62:1 — nothing.
Lightness moved it a great deal. So the palette takes its contrast from lightness
and leaves the loudness behind: 6.75:1 at chroma 0.15, against 0.24 before.

**Surfaces are inverted from the obvious arrangement.** The page carries the
tint (`base-200`) and cards are white (`base-100`), so a card *lifts*. With a
white page and grey cards, a card reads as a dent and needs a border to be seen.
Use `.shadow-z1/z2/z3` instead of `border` on cards.

**`info` is teal because it was blue.** When "this is us" and "this is a notice"
are the same blue, neither reads. Small-text tokens are darkened to hold 4.5:1 at
badge sizes — `secondary` at 0.52 rather than 0.58, `info` at 0.50 rather than
0.58. Fixing the token fixes every use; overriding the badge fixes one.

### Type

`--font-sans` is Inter (with `cv11`, `ss01`, `ss03` stylistic sets and
`-0.005em` tracking); `--font-mono` is JetBrains Mono. A display scale exists as
`--font-display-2xl/xl/lg`, and `h1`/`h2`/`h3` carry it by default.

**Heading defaults live in `@layer base`, in longhand.** Both halves matter.
Unlayered CSS beats every Tailwind utility regardless of specificity, and the
`font:` shorthand resets size, weight, line-height and family together — so a
rule written unlayered *and* in shorthand leaves nothing for a utility to
override. That combination once silently disabled `text-sm` and `font-semibold`
on about a hundred headings; collection cards asking for 14px rendered at 24px.

### Density

Two modes, toggled with `data-density="compact"` on `<html>`.
Comfortable is the default; compact runs at `--density-scale: 0.8` for
spreadsheet-style workflows. Tables, card bodies and small buttons respond.

### Motion

Three named curves, used by role, rather than a hand-written cubic-bezier per
call site:

| Token | For |
|---|---|
| `--z-ease-snap` | Entering, responding |
| `--z-ease-move` | Moving on screen |
| `--z-ease-drawer` | Panels and sheets |

They are prefixed `--z-` deliberately: Tailwind 4 defines `--ease-out` and
`--ease-in-out` as theme tokens that land later in `:root`, so unprefixed names
would be silently replaced by weaker built-ins.

All motion is wrapped in `@media (prefers-reduced-motion: reduce)`.

---

## 2. Accessibility

The target is **WCAG 2.1 AA**, and it is held at the token level so that a fix
lands everywhere at once.

Three daisyUI defaults sat just under the line and are raised to a 65% floor:
table column headers (4.37:1), inactive tabs (3.16:1), and `badge-ghost`
(3.99:1). A column header is text a person reads to understand a table, not
chrome — 4.37 against a required 4.5 is exactly the near-miss that survives
review because it looks fine.

Those overrides live in **`@layer utilities`**, which is where daisyUI 5 actually
emits them. Two earlier attempts failed instructively: `@layer components` loses
to utilities regardless of specificity, and raising specificity inside
`components` changes nothing, because layer order is decided before specificity
is consulted. Writing them unlayered would have won — and would have repeated
the mechanism that disabled a hundred headings.

Also provided: `.sr-only`, a `.skip-link` that appears on focus, visible focus
rings, and a print stylesheet.

---

## 3. daisyUI 5 on a daisyUI 4 codebase

This is the single most useful thing to know before editing a form.

`form-control`, `label-text` and `label-text-alt` were **removed in daisyUI 5**
and emit no CSS. This Studio uses them 149 and 213 times. `.label` survived but
had its meaning inverted — in v5 it is an inline chip meant to sit *inside* an
input wrapper, while this markup puts it *above* the input, as v4 did.

Measured on the settings page before the fix: five fields, five different left
edges (392, 431, 577, 579, 587px), three different widths, not one pair aligned,
and labels running into their own hints so that "Site URL Used in emails and
webhooks" read as one broken sentence.

Those four classes are therefore **re-implemented in `@layer components`** in
`app.css` — twenty lines, scoped under `.form-control` so the v5
`.label`-inside-an-input pattern still works. It is reversible and it fixed
every screen at once, rather than the ones somebody remembered to edit.

**Do not "modernise" a form by deleting `form-control`.** Either leave it, or
migrate every one of the 362 call sites in a single deliberate change.

---

## 4. Where the code is

```
packages/studio/src/
├── app.css                       the design system — tokens, layers, overrides
└── lib/
    ├── components/
    │   ├── common/               shared building blocks (see components.md)
    │   ├── layout/               shell, sidebar, topbar
    │   ├── navigation/           nav rendering from nav-model.ts
    │   ├── collections/          collection editor and data grid
    │   ├── fields/               field-type editors
    │   ├── admin/                admin-only widgets
    │   ├── extension/            extension host components
    │   └── marketplace/          marketplace UI
    └── sdui/                     the server-driven UI renderer
```

`packages/client/src/lib/components/` and `blocks/` carry the end-user surface,
sharing the tokens and the sanitisation helpers.
