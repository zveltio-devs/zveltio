import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `GET /api/extensions` was read as `res.json()` with no look at the status.
 * A 401 (session expired), a 403 or a 500 all parse as a problem+json body
 * with no `extensions` key, so the store fell back to `[]` and set
 * `initialized = true`: the admin shell rendered as an instance with no
 * extensions installed, every extension nav group silently gone, and nothing
 * anywhere saying the request had failed. Same shape as the C10 finding on
 * `api.fetch().then((r) => r.json())`.
 */
const fetchMock = vi.fn();
vi.mock('$lib/api.js', () => ({ api: { fetch: (...a: unknown[]) => fetchMock(...a) } }));

const { extensions, initExtensions, refreshExtensions } = await import('./extensions.svelte.js');

function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('extensions store', () => {
  it('loads the active list on success', async () => {
    fetchMock.mockResolvedValue(res(200, { extensions: ['crm', 'ai'], meta: [{ name: 'crm' }] }));
    await initExtensions();
    expect(extensions.active).toEqual(['crm', 'ai']);
    expect(extensions.isActive('crm')).toBe(true);
    expect(extensions.initialized).toBe(true);
  });

  it('a 401 does not become "no extensions installed"', async () => {
    fetchMock.mockResolvedValue(res(200, { extensions: ['crm'], meta: [] }));
    await initExtensions();

    fetchMock.mockResolvedValue(res(401, { title: 'Unauthorized', status: 401 }));
    await refreshExtensions();

    expect(extensions.active, 'a failed refresh emptied the extension list').toEqual(['crm']);
  });

  it('a 500 on the first load leaves the list empty but reports failure', async () => {
    fetchMock.mockResolvedValue(res(500, { title: 'Internal Server Error' }));
    await initExtensions();
    expect(extensions.initialized).toBe(true);
    expect(extensions.loadFailed).toBe(true);
  });
});
