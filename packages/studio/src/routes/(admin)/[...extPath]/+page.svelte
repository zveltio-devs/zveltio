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
import { extensions, refreshExtensions } from '$lib/extensions.svelte.js';
import { validateSchema } from '$lib/sdui/validate.js';
import SchemaPage from '$lib/sdui/SchemaPage.svelte';
import SettingsPage from '$lib/sdui/SettingsPage.svelte';
import { m } from '$lib/i18n.svelte.js';
import { PackageX, TriangleAlert } from '@lucide/svelte';

const slug = $derived((page.params.extPath ?? '').replace(/\/$/, ''));

// Re-read the schemas whenever an extension page is opened.
//
// `initExtensions` runs once and keeps every extension's schema in memory for
// the life of the SPA session, and nothing refetches on navigation. So an
// administrator who changes a page — adds a field, fixes a column, enables a
// resource — changes nothing for anybody already logged in, and there is no
// sign of it: the form simply keeps its old shape until someone happens to do
// a full browser reload. Measured on this very page, which served a four-field
// invoice form while the engine had been serving a twenty-field one for hours.
//
// The page that DEPENDS on a schema is the right place to revalidate it, and
// the cost is one request per navigation. The result is a plain reassignment
// of the store, so nothing re-renders unless the schema actually differs.
$effect(() => {
  void slug;
  refreshExtensions();
});

const resolved = $derived.by(() => {
  for (const meta of extensions.meta) {
    if (!extensions.isActive(meta.name)) continue;
    for (const pg of meta.studio?.pages ?? []) {
      const pgSlug = pg.path
        .replace(/^\/admin\//, '')
        .replace(/^\//, '')
        .replace(/\/$/, '');
      if (pgSlug === slug && pg.render === 'schema' && pg.schema) {
        // Carry the owning extension name so the renderer can refuse mutations
        // outside the extension's own /ext/<name>/ namespace (defense-in-depth;
        // the publish validator is the primary control).
        return { ...validateSchema(pg.schema), extName: meta.name as string };
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
      <div class="font-semibold text-sm">{m['extPage.renderFailed']()}</div>
      <div class="text-xs opacity-80">{resolved.error}</div>
    </div>
  </div>
{:else if resolved.kind === 'settings'}
  <div class="p-6">
    <SettingsPage schema={resolved.schema as any} extName={resolved.extName} />
  </div>
{:else}
  <div class="p-6">
    {#key slug}
      <SchemaPage schema={resolved.schema as any} extName={resolved.extName} />
    {/key}
  </div>
{/if}
