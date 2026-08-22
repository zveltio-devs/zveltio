import { redirect } from '@sveltejs/kit';
import { base } from '$app/paths';

/**
 * Legacy CRM sub-paths (`/admin/crm/contacts`, …) predated the unified SDUI
 * schema at `/admin/crm`. Redirect with `?tab=` so bookmarks keep working.
 */
const LEGACY_CRM_TAB: Record<string, string> = {
  'crm/contacts': 'contacts',
  'crm/organizations': 'organizations',
  'crm/transactions': 'deals',
};

export const prerender = false;

export function load({ params }: { params: { extPath?: string } }) {
  const slug = (params.extPath ?? '').replace(/\/$/, '');
  const tab = LEGACY_CRM_TAB[slug];
  if (!tab) return;
  redirect(301, `${base}/crm?tab=${encodeURIComponent(tab)}`);
}
