<!--
  The reference host's block renderer — now a delegation, not an implementation.

  This file used to draw the blocks itself, against the vocabulary of a Studio
  editor that was replaced in April 2026 and accidentally restored in May. The
  extension that DEFINES the blocks kept evolving; this copy did not, and nothing
  connected the two, so they ended up sharing two block types out of twelve. A
  page built from the full library rendered as ten "Unsupported block"
  placeholders and one `<hr>` — and `image` drew nothing at all, because the
  builder writes `content.url` and this file read `content.src`.

  Per the owner's rule — everything belonging to an extension lives in the
  extension — the renderer is now `content/pages/client/BlockRenderer.svelte`,
  and `scripts/sync-extension-clients.ts` copies it here at build time. The copy
  under `$lib/ext/` is GENERATED and committed, exactly like the Studio's
  extension routes: a release build with no extensions checked out keeps the
  committed snapshot rather than overwriting it with nothing.

  Keeping this wrapper rather than importing the generated file everywhere means
  the host still has one name for "draw a page", and the swap stays invisible to
  callers and to this directory's tests.
-->
<script lang="ts">
import ExtensionBlockRenderer from '$lib/ext/content/pages/BlockRenderer.svelte';

// Forwarded wholesale rather than named one by one: a wrapper that lists props
// silently drops the next one added to the component it delegates to, which is
// how `record` arrived here and went nowhere.
let props = $props();
</script>

<ExtensionBlockRenderer {...props} />
