<script lang="ts">
/**
 * Declarative extension page host (SDUI).
 *
 * Lowest-priority route in (admin): any /admin/<slug> NOT matched by a real
 * (baked) route lands here. If an active extension declares a schema page for
 * that slug — exact or parametric (`forms/:id`) — render it with the generic
 * host renderers. Otherwise show a 404.
 */
import { page } from '$app/state';
import { extensions, refreshExtensions } from '$lib/extensions.svelte.js';
import { validateSchema } from '$lib/sdui/validate.js';
import SchemaPage from '$lib/sdui/SchemaPage.svelte';
import SettingsPage from '$lib/sdui/SettingsPage.svelte';
import { m } from '$lib/i18n.svelte.js';
import { PackageX, TriangleAlert } from '@lucide/svelte';

const slug = $derived((page.params.extPath ?? '').replace(/\/$/, ''));

$effect(() => {
  void slug;
  refreshExtensions();
});

/** Match `forms/:id` against `forms/uuid` → `{ id: 'uuid' }`, or null. */
function matchPath(pattern: string, actual: string): Record<string, string> | null {
  const pp = pattern.split('/').filter(Boolean);
  const ss = actual.split('/').filter(Boolean);
  if (pp.length !== ss.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(':')) params[pp[i].slice(1)] = ss[i];
    else if (pp[i] !== ss[i]) return null;
  }
  return params;
}

const resolved = $derived.by(() => {
  let best: {
    score: number;
    result: ReturnType<typeof validateSchema> & {
      extName: string;
      routeParams: Record<string, string>;
    };
  } | null = null;

  for (const meta of extensions.meta) {
    if (!extensions.isActive(meta.name)) continue;
    for (const pg of meta.studio?.pages ?? []) {
      if (pg.render !== 'schema' || !pg.schema) continue;
      const pgSlug = pg.path
        .replace(/^\/admin\//, '')
        .replace(/^\//, '')
        .replace(/\/$/, '');
      let routeParams: Record<string, string> = {};
      let score = -1;
      if (pgSlug === slug) {
        score = 1000; // exact wins
      } else {
        const m = matchPath(pgSlug, slug);
        if (!m) continue;
        // Prefer fewer params (more literal segments).
        score = 500 - Object.keys(m).length;
        routeParams = m;
      }
      if (score < 0) continue;
      if (best && best.score >= score) continue;
      best = {
        score,
        result: { ...validateSchema(pg.schema), extName: meta.name as string, routeParams },
      };
    }
  }
  return best?.result ?? null;
});
</script>

{#if resolved === null}
  <div class="flex flex-col items-center justify-center py-24 text-center gap-3">
    <PackageX size={40} class="text-base-content/55" />
    <h1 class="text-lg font-semibold">{m['common.notFound']?.() ?? 'Page not found'}</h1>
    <p class="text-sm text-base-content/65 max-w-md">
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
      <SchemaPage
        schema={resolved.schema as any}
        extName={resolved.extName}
        routeParams={resolved.routeParams}
      />
    {/key}
  </div>
{/if}
