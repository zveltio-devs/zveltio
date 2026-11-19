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

/** The message of an engine error response: its problem `detail`, or a legacy `error`. */
export async function problemText(res: Response): Promise<string | undefined> {
  const body = (await res.json().catch(() => null)) as { detail?: unknown; error?: unknown } | null;
  const text = body?.detail ?? body?.error;
  return typeof text === 'string' && text ? text : undefined;
}
