// $app/state stub for Vitest. The real SvelteKit module exposes a
// reactive `page` runtime hooked into the router. In a test environment
// there is no router, so we expose a static skeleton matching the
// shape callers read. Override via `vi.mock('$app/state', ...)` in
// tests that need specific URL params.
export const page = {
  url: new URL('http://localhost:5173/'),
  params: {} as Record<string, string>,
  route: { id: null as string | null },
  status: 200,
  error: null as Error | null,
  data: {} as Record<string, unknown>,
  form: undefined as unknown,
  state: {} as Record<string, unknown>,
};

export const navigating = null;
export const updated = { current: false, check: async () => false };
