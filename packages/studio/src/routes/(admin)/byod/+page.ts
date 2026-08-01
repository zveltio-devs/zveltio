import { redirect } from '@sveltejs/kit';
import { base } from '$app/paths';

/**
 * `/byod` is a second, diverged implementation of `/introspect`.
 *
 * Both existed and neither was a copy of the other — they had drifted, so a fix
 * had to be made twice and usually was not. The navigation only ever linked to
 * `/introspect`, which makes that one canonical and this one reachable solely
 * by an old bookmark.
 *
 * A 301 rather than deleting the route: the path may be in someone's history or
 * in a document, and a redirect answers that correctly where a 404 would just
 * look broken.
 */
export const prerender = false;

export function load() {
  redirect(301, `${base}/introspect`);
}
