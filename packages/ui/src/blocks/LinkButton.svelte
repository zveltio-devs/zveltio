<script lang="ts">
/** A link drawn as a button (`@zveltio/ui/blocks`). */
import { type LinkVariant, linkClass, safeHref } from './href.js';

let {
  label,
  href,
  variant = 'primary',
  class: extra = '',
}: { label: string; href: string; variant?: LinkVariant; class?: string } = $props();
</script>

<a href={safeHref(href)} class={[linkClass(variant), extra]}>{label}</a>
