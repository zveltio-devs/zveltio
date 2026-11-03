const ENGINE_URL: string =
  import.meta.env.PUBLIC_ENGINE_URL ||
  (typeof window !== 'undefined' ? window.location.origin : '');

/** `fetch` against the engine: a path such as `/api/data/pages` gets the engine's origin. */
export function engineFetch(f: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    f(
      typeof input === 'string' && input.startsWith('/') ? ENGINE_URL + input : input,
      init,
    )) as typeof fetch;
}
