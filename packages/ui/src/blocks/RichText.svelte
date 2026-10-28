<script lang="ts">
/**
 * Authored rich text (`@zveltio/ui/blocks`). `html` must already be sanitized
 * by the caller: the kit draws it as given. `prose` styles it unless `raw`
 * (an embed is not body copy).
 */
let { html, raw = false }: { html: string; raw?: boolean } = $props();
</script>

<div class={raw ? undefined : 'prose max-w-none'}>{@html html}</div>
