# @zveltio/ui

The UI kit of [Zveltio](https://github.com/zveltio-devs/zveltio): the components
the Console, the App and extensions are built from, for Svelte 5 with
Tailwind CSS 4 and daisyUI 5. Interactive components get their behaviour
(focus, keyboard, ARIA) from [bits-ui](https://bits-ui.com).

## Install

```sh
npm install @zveltio/ui
```

Peer: `svelte@^5`. Your app needs Tailwind 4 with the daisyUI 5 plugin, and must
let Tailwind see the kit's classes:

```css
@import 'tailwindcss';
@plugin 'daisyui';
@source '../node_modules/@zveltio/ui/dist';
```

## Words come from you

The kit has no message catalogue. Every component that shows text takes it as
props (`labels`, `title`, …), so your app translates it once, in its own
catalogue.

## Themes are data

A theme is a few daisyUI tokens (colours, radius, border, font, density), as the
engine stores it. Apply one to any element:

```svelte
<script lang="ts">
  import { themeName, themeStyle } from '@zveltio/ui/theme';
  let { theme } = $props();
</script>

<div data-theme={themeName(theme)} style={themeStyle(theme)}>…</div>
```

Every value is checked again before it reaches the style attribute; one that is
not a colour, a length or a known name is dropped. `importDaisyTheme(css)` turns
a daisyUI theme block into the same data.

## What is in it

- Base: `Button`, `Card`, `Dialog`, `Dropdown`, `EmptyState`, `Field`,
  `Filters`, `PageHeader`, `Pagination`, `Table`, `Tabs`, `Toaster` (with
  `@zveltio/ui/toast`), `StepUpDialog` (with `@zveltio/ui/step-up`).
- Data: `CollectionList` and `CollectionForm` draw any collection from the shape
  `GET /api/data` returns (`@zveltio/ui/collection`, `@zveltio/ui/fields`).
- Page blocks: `@zveltio/ui/blocks/*.svelte` (`Hero`, `Heading`, `RichText`,
  `Figure`, `LinkButton`, `CallToAction`, `Stats`, `Gallery`, `Video`, `Icon`,
  `Divider`, `Spacer`, `Grid`). `RichText` draws HTML as given: sanitize it
  first. Links pass `safeHref` (`@zveltio/ui/blocks/href`).

Import each component by its path:

```ts
import Dialog from '@zveltio/ui/Dialog.svelte';
import Hero from '@zveltio/ui/blocks/Hero.svelte';
```
