import type { HandleFetch } from '@sveltejs/kit/hooks';

/**
 * A server-side `load` that calls the engine API on this origin is answered by
 * the engine in-process (ADR 0005), with the visitor's own credentials, rather
 * than over the network back to the public URL.
 */
export const handleFetch: HandleFetch = ({ event, request, fetch }) => {
  const url = new URL(request.url);
  if (
    event.platform?.engineFetch &&
    url.origin === event.url.origin &&
    /^\/(api|ext)\//.test(url.pathname)
  ) {
    return event.platform.engineFetch(request);
  }
  return fetch(request);
};
