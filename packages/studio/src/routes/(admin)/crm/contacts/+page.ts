import { redirect } from '@sveltejs/kit';
import { base } from '$app/paths';

/**
 * `/admin/crm/contacts` was a second implementation of a surface the CRM
 * manifest already serves at `/admin/crm` through its SDUI schema, which
 * covers contacts, organizations and deals alike.
 *
 * It was never linked from the navigation and it did not work: every call went
 * to `/contacts` with no `/ext/crm` prefix, so the page answered 404 on
 * load. Two implementations of one screen means a fix has to be made twice and
 * usually is not — here the unlinked one had simply stopped working and nobody
 * saw it, because nothing led there.
 *
 * A 301 rather than deleting the route outright: the path may sit in someone's
 * history or in a document, and a redirect answers that correctly where a 404
 * would only look broken.
 */
export const prerender = false;

export function load() {
  redirect(301, `${base}/crm`);
}
