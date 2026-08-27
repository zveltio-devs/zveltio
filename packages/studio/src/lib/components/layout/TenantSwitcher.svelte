<script lang="ts">
/**
 * Which unit am I standing in, and how do I move.
 *
 * Hierarchical tenancy shipped with no way to answer either question from the
 * Studio: the engine read `x-tenant-slug` off the request and this client never
 * sent it. What a person could read depended on a unit they could not see.
 *
 * Deliberately a full reload on switch rather than a reactive re-fetch. Every
 * open screen holds data scoped to the old unit — a half-swapped Studio showing
 * one unit's records under another unit's name is worse than a second of blank.
 */
import { onMount } from 'svelte';
import { Building2, Check, ChevronsUpDown } from '@lucide/svelte';
import { api, currentTenantSlug, setCurrentTenantSlug } from '$lib/api.js';
import { m } from '$lib/i18n.svelte.js';

type Tenant = { id: string; name: string; slug: string; parent_id?: string | null };

let tenants = $state<Tenant[]>([]);
let open = $state(false);
let loaded = $state(false);
const active = $derived(tenants.find((t) => t.slug === currentTenantSlug()) ?? tenants[0] ?? null);

onMount(async () => {
  try {
    // `/api/tenants/me`, not `/api/tenants`. The latter is instance-admin only
    // AND is itself tenant-scoped by RLS, so it answers "which units exist in
    // the unit I am already in" — which is one, always, and is not the question
    // a switcher asks. `/me` answers from the person's assignments.
    const res = await api.get<{ tenants: Tenant[] }>('/api/tenants/me');
    tenants = res.tenants ?? [];
  } catch {
    tenants = []; // no access to the list is not an error worth a banner
  } finally {
    loaded = true;
  }
});

function pick(t: Tenant) {
  open = false;
  if (t.slug === currentTenantSlug()) return;
  setCurrentTenantSlug(t.slug);
  window.location.reload();
}

/** Children are indented one step. Deeper nesting is rare and reads fine flat. */
function isChild(t: Tenant): boolean {
  return !!t.parent_id && tenants.some((p) => p.id === t.parent_id);
}
</script>

{#if loaded && tenants.length > 1}
  <div class="dropdown">
    <button
      type="button"
      class="btn btn-ghost btn-sm gap-2 font-normal"
      onclick={() => (open = !open)}
      aria-haspopup="listbox"
      aria-expanded={open}
    >
      <Building2 size={15} class="text-base-content/65" />
      <span class="max-w-40 truncate">{active?.name ?? m['tenantSwitcher.choose']()}</span>
      <ChevronsUpDown size={13} class="text-base-content/65" />
    </button>
    {#if open}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <ul
        class="dropdown-content menu z-50 mt-1 max-h-80 w-64 flex-nowrap overflow-y-auto rounded-box bg-base-100 p-1.5 shadow-z2"
        role="listbox"
        tabindex="-1"
      >
        <li class="menu-title px-2 py-1 text-[11px] uppercase tracking-[.1em]">
          {m['tenantSwitcher.label']()}
        </li>
        {#each tenants as t (t.id)}
          <li>
            <button
              type="button"
              role="option"
              aria-selected={t.slug === active?.slug}
              class="justify-between {isChild(t) ? 'pl-6' : ''}"
              onclick={() => pick(t)}
            >
              <span class="truncate">{t.name}</span>
              {#if t.slug === active?.slug}<Check size={14} class="text-primary shrink-0" />{/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}
