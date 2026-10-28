<script lang="ts">
import { m } from '#lib/i18n.svelte.js';
import { useAuth } from '#lib/stores/auth.svelte.js';
import { LogIn, UserPlus } from '@lucide/svelte';
import BlockRenderer from '#lib/blocks/BlockRenderer.svelte';
import Popup from '#lib/ext/content/pages/Popup.svelte';

let { data } = $props();

const auth = useAuth();
const theme = $derived(data?.theme ?? null);
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
const nav = $derived((data?.nav ?? []) as any[]);
const appName = $derived(
  theme?.app_name ?? import.meta.env.PUBLIC_APP_NAME ?? m['home.default_name'](),
);
// `/` is the login landing by DEFAULT (ADR 0001). A published page-builder
// homepage (slug `home`) is an optional override that takes over when present.
const homepage = $derived(data?.homepage ?? null);
// "Create Account" shows only when self-registration is enabled (server enforces
// the same gate). Default off — app/intranet-first, signup is opt-in.
const registrationEnabled = $derived(data?.registrationEnabled === true);
</script>

<svelte:head>
  <title>{homepage?.page?.meta_title ?? homepage?.page?.title ?? appName}</title>
  {#if homepage?.page?.meta_description}
    <meta name="description" content={homepage.page.meta_description} />
  {/if}
</svelte:head>

{#if homepage?.page}
  <BlockRenderer blocks={homepage.blocks} record={homepage.record ?? null}
    blocksBaseUrl={homepage.blocksBaseUrl ?? ''} />
  <!-- Popups that belong on this page, already resolved by the server. -->
  {#each (homepage.popups ?? []) as popup (popup.id)}
    <Popup {popup} blocksBaseUrl={homepage.blocksBaseUrl ?? ''} />
  {/each}
{:else}
<!-- Default `/`: the login landing (app/intranet-first). A published page-builder
     homepage would override this; none here, so login is the intended entry. -->
<div class="min-h-screen flex items-center justify-center bg-base-200">
  <div class="text-center max-w-lg px-6">
    {#if theme?.logo_url}
      <img src={theme.logo_url} alt={appName} class="h-16 w-auto mx-auto mb-6"/>
    {/if}

    <h1 class="text-4xl font-bold mb-3">{appName}</h1>
    <p class="text-base opacity-60 mb-8">{m['home.welcome']()}</p>

    {#if auth.isPending}
      <span class="loading loading-spinner loading-md text-primary"></span>
    {:else if auth.isLoggedIn}
      <a href="/app" class="btn btn-primary">{m['home.open_workspace']()}</a>
    {:else}
      <div class="flex gap-4 justify-center">
        <a href="/auth/login" class="btn btn-primary">
          <LogIn size={18}/>{m['auth.sign_in']()}</a>
        {#if registrationEnabled}
          <a href="/auth/signup" class="btn btn-outline btn-primary">
            <UserPlus size={18}/>{m['auth.sign_up']()}</a>
        {/if}
      </div>
    {/if}

    {#if nav.length > 0}
      <nav class="mt-8 flex gap-3 justify-center flex-wrap text-sm opacity-60">
        {#each nav as item}
          <a href="/{item.slug === '/' ? '' : item.slug}"
            class="link link-primary hover:opacity-100 transition-opacity">
            {item.title}
          </a>
        {/each}
      </nav>
    {/if}
  </div>
</div>
{/if}
