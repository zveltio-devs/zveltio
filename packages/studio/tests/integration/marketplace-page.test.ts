import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The marketplace page, mounted against a live engine.
 *
 * The page reads `installed_version`, `catalog_version` and `update_available`
 * from `GET /api/marketplace` to show the running version and offer Update. The
 * unit test types that shape by hand; this one checks the engine sends it, and
 * that the page renders the engine's own catalogue with it.
 *
 * Not covered here: clicking Update. It needs an extension installed from a
 * registry that serves a newer version, and this lane has no registry. The
 * route is covered in the engine's unit suite.
 */
vi.mock('$app/navigation', () => ({ replaceState: vi.fn(), goto: vi.fn() }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/admin/marketplace') } }));

import { api } from '#lib/api.js';
import Page from '../../src/routes/(admin)/marketplace/+page.svelte';

interface Listed {
  name: string;
  displayName: string;
  installed_version: string | null;
  catalog_version: string;
  update_available: boolean;
}

afterEach(cleanup);

describe('marketplace — against the engine', () => {
  it('lists versions the page can offer an update from', async () => {
    const { extensions } = await api.get<{ extensions: Listed[] }>('/api/marketplace');
    expect(extensions.length).toBeGreaterThan(0);
    for (const e of extensions) {
      expect(typeof e.catalog_version).toBe('string');
      expect(typeof e.update_available).toBe('boolean');
      expect(e.installed_version === null || typeof e.installed_version === 'string').toBe(true);
      // Nothing to update from when nothing is on disk.
      if (e.installed_version === null) expect(e.update_available).toBe(false);
    }

    render(Page);
    await waitFor(() => expect(document.body.textContent).toContain(extensions[0]!.displayName));
  });
});
