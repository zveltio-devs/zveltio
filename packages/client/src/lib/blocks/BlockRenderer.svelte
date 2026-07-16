<!--
  Block registry — the reference host's renderer for the page-builder public
  contract (ADR 0001). A page is `blocks: [{ type, content }]`; this maps each
  `type` to markup. Types mirror the live Studio editor's vocabulary
  (heading/text/image/button/divider/html). Unknown types degrade to a visible
  placeholder, never a crash — that is the contract's forward-compat rule.

  `html`/`text` render authored HTML with {@html}. That content is authored by
  admins through the page builder (a trusted, permissioned surface), the same
  trust boundary as any CMS theme.
-->
<script lang="ts">
// biome-ignore lint/suspicious/noExplicitAny: contract blocks are untyped JSON
let { blocks = [] as any[] } = $props();

function headingTag(level: unknown): 'h1' | 'h2' | 'h3' | 'h4' {
  const n = Number(level);
  return (['h1', 'h1', 'h2', 'h3', 'h4'][n] ?? 'h2') as 'h1' | 'h2' | 'h3' | 'h4';
}
const BTN: Record<string, string> = {
  primary: 'btn btn-primary',
  secondary: 'btn btn-secondary',
  ghost: 'btn btn-ghost',
  link: 'btn btn-link',
};
</script>

<div class="mx-auto max-w-3xl px-4 sm:px-6 py-10 space-y-6">
  {#each blocks as block (block)}
    {@const c = block.content ?? {}}
    {#if block.type === 'heading'}
      <svelte:element this={headingTag(c.level)} class="font-bold tracking-tight
        {c.level === 1 ? 'text-4xl sm:text-5xl' : c.level === 2 ? 'text-3xl' : 'text-2xl'}">
        {c.text ?? ''}
      </svelte:element>
    {:else if block.type === 'text'}
      <!-- authored HTML from the page builder -->
      <div class="prose max-w-none">{@html c.html ?? ''}</div>
    {:else if block.type === 'image'}
      {#if c.src}
        <img src={c.src} alt={c.alt ?? ''} style={c.width ? `width:${c.width}` : undefined}
          class="rounded-lg max-w-full h-auto" />
      {/if}
    {:else if block.type === 'button'}
      <div>
        <a href={c.href ?? '#'} class={BTN[c.variant as string] ?? 'btn btn-primary'}>
          {c.label ?? 'Button'}
        </a>
      </div>
    {:else if block.type === 'divider'}
      <hr class="border-base-300" />
    {:else if block.type === 'html'}
      <!-- authored raw HTML from the page builder -->
      <div>{@html c.code ?? ''}</div>
    {:else}
      <div class="rounded-lg border border-dashed border-base-300 p-4 text-sm opacity-50">
        Unsupported block: {block.type}
      </div>
    {/if}
  {/each}
</div>
