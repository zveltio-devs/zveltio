<script lang="ts">
import BlockRenderer from '$lib/blocks/BlockRenderer.svelte';
import { safeCss } from '$lib/sanitize';
import { m } from '$lib/i18n.svelte.js';

let { data } = $props();
</script>

<svelte:head>
  <title>{data.page?.title ?? data.site?.name ?? 'Portal'}</title>
  <!-- A private page is never for a crawler, whatever its SEO fields say. -->
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

{#if data.status === 401}
  <div class="mx-auto max-w-lg px-6 py-20 text-center">
    <h1 class="text-2xl font-semibold mb-2">{m['portal.sign_in_title']()}</h1>
    <p class="opacity-70 mb-6">{m['portal.sign_in_body']()}</p>
    <a href="/auth/login" class="btn btn-primary">{m['portal.sign_in_action']()}</a>
  </div>
{:else if data.status === 403}
  <div class="mx-auto max-w-lg px-6 py-20 text-center">
    <h1 class="text-2xl font-semibold mb-2">{m['portal.forbidden_title']()}</h1>
    <p class="opacity-70">{m['portal.forbidden_body']()}</p>
  </div>
{:else if !data.page}
  <div class="mx-auto max-w-lg px-6 py-20 text-center">
    <h1 class="text-2xl font-semibold mb-2">{m['portal.missing_title']()}</h1>
    <p class="opacity-70">{m['portal.missing_body']()}</p>
  </div>
{:else}
  {#if data.site?.custom_css}
    <!--
      Through `safeCss`, and through a real `<style>` element rather than
      `{@html}`. The raw version concatenated operator CSS into markup: a
      `</style>` in the value closed the element and everything after it was
      parsed as HTML, so whoever could edit a site's theme had script execution
      on every visitor of that portal. `safeCss` is the same filter the root
      layout already used for the identical field.
    -->
    <style>{safeCss(data.site.custom_css)}</style>
  {/if}
  <BlockRenderer
    blocks={data.blocks}
    record={data.record ?? null}
    blocksBaseUrl={data.blocksBaseUrl ?? ''}
  />
{/if}
