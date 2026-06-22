<script lang="ts">
/**
 * Declarative extension page host (SDUI).
 *
 * Lowest-priority route in (admin): any /admin/<slug> NOT matched by a real
 * (baked) route lands here. If an active extension declares a schema page for
 * that slug, render it with the generic host renderers — no per-extension
 * code, no build. Otherwise show a 404. This is what lets declarative
 * extensions work with zero build toolchain on the host.
 */
import { page } from '$app/state';
import { extensions } from '$lib/extensions.svelte.js';
import { validateSchema } from '$lib/sdui/validate.js';
import SchemaPage from '$lib/sdui/SchemaPage.svelte';
import SettingsPage from '$lib/sdui/SettingsPage.svelte';
import { m } from '$lib/i18n.svelte.js';
import { PackageX, TriangleAlert } from '@lucide/svelte';

const slug = $derived((page.params.extPath ?? '').replace(/\/$/, ''));

const resolved = $derived.by(() => {
  for (const meta of extensions.meta) {
    if (!extensions.isActive(meta.name)) continue;
    for (const pg of meta.studio?.pages ?? []) {
      const pgSlug = pg.path
        .replace(/^\/admin\//, '')
        .replace(/^\//, '')
        .replace(/\/$/, '');
      if (pgSlug === slug && pg.render === 'schema' && pg.schema) {
        return validateSchema(pg.schema);
      }
    }
  }
  return null;
});
</script>

{#if resolved === null}
  <div class="flex flex-col items-center justify-center py-24 text-center gap-3">
    <PackageX size={40} class="text-base-content/20" />
    <h1 class="text-lg font-semibold">{m['common.notFound']?.() ?? 'Page not found'}</h1>
    <p class="text-sm text-base-content/50 max-w-md">
      Nothing is registered at <code class="text-xs">/{slug}</code>. If this is an extension page,
      make sure the extension is installed and enabled.
    </p>
  </div>
{:else if !resolved.ok}
  <div class="m-6 alert alert-warning">
    <TriangleAlert size={18} />
    <div>
      <div class="font-semibold text-sm">This extension page could not be rendered</div>
      <div class="text-xs opacity-80">{resolved.error}</div>
    </div>
  </div>
{:else if resolved.kind === 'settings'}
  <div class="p-6">
    <SettingsPage schema={resolved.schema as any} />
  </div>
{:else}
  <div class="p-6">
    {#key slug}
      <SchemaPage schema={resolved.schema as any} />
    {/key}
  </div>
{/if}
