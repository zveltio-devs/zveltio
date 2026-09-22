import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * "Test connection" used to dial the source from the BROWSER.
 *
 * Two requests, both wrong. First `POST /api/data/<name>` — a record create, so
 * testing against the name of an existing collection inserted an empty row into
 * it. Then, on failure, a bare `fetch(source_url)` from the browser carrying the
 * typed credential: outside the engine's SSRF guard, reaching the
 * administrator's network rather than the engine's, and handing the token to
 * whatever host had been typed.
 *
 * It now goes to `POST /api/collections/virtual-test`, which runs the same
 * adapter the collection will use — `safeFetch`, redirects re-validated.
 */
const { post, get } = vi.hoisted(() => ({
  // Typed: an untyped `vi.fn()` infers its arguments as the empty tuple, and
  // reading `mock.calls[0][0]` below then fails typecheck with TS2493.
  post: vi.fn(async (_path: string, _body?: unknown) => ({
    ok: true,
    total: 3,
    sample: { id: 1 },
  })),
  get: vi.fn(async () => ({ collections: [] })),
}));

vi.mock('$lib/api.js', () => ({ api: { post, get } }));
vi.mock('$lib/stores/toast.svelte.js', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('$app/paths', () => ({ base: '/admin' }));

import Page from './+page.svelte';

const fetchSpy = vi.spyOn(globalThis, 'fetch');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('virtual collections — the connection test', () => {
  it('probes through the engine and never from the browser', async () => {
    const { container } = render(Page);
    await waitFor(() => expect(get).toHaveBeenCalled());

    (container.querySelector('button.btn-primary') as HTMLButtonElement).click();

    const url = await waitFor(() => {
      const el = document.querySelector('#vc-source-url') as HTMLInputElement;
      if (!el) throw new Error('no url field');
      return el;
    });
    await fireEvent.input(url, { target: { value: 'https://api.example.com/v1/customers' } });

    const test = [...document.querySelectorAll('button')].find((b) =>
      /test/i.test(b.textContent ?? ''),
    ) as HTMLButtonElement;
    test.click();

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, body] = post.mock.calls[0];
    expect(path).toBe('/api/collections/virtual-test');
    expect(body).toMatchObject({ source_url: 'https://api.example.com/v1/customers' });

    // Nothing was written, and nothing left the browser directly.
    expect(post.mock.calls.some(([p]) => String(p).startsWith('/api/data/'))).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
