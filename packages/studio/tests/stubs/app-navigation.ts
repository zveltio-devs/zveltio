// $app/navigation stub for Vitest. Real SvelteKit module performs
// router operations — in tests we just record the calls. Override via
// vi.mock when you need to assert navigation behavior.
export async function goto(_url: string | URL, _opts?: unknown): Promise<void> {
  return;
}

export async function invalidate(_resource?: string | URL): Promise<void> {
  return;
}

export async function invalidateAll(): Promise<void> {
  return;
}

export async function preloadData(_url: string | URL): Promise<{ type: string }> {
  return { type: 'loaded' };
}

export async function preloadCode(..._urls: string[]): Promise<void> {
  return;
}

export async function pushState(
  _url: string | URL,
  _state: Record<string, unknown>,
): Promise<void> {
  return;
}

export async function replaceState(
  _url: string | URL,
  _state: Record<string, unknown>,
): Promise<void> {
  return;
}

export function afterNavigate(_cb: unknown): void {
  /* noop */
}
export function beforeNavigate(_cb: unknown): void {
  /* noop */
}
export function onNavigate(_cb: unknown): void {
  /* noop */
}
