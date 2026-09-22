import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The root loader fetched `/api/zones/client/render` and read `zone`/`pages`.
 * The engine stopped mounting `/api/zones` when zones became sites inside
 * `content/pages`, so the request 404'd on every install, the failure fell into
 * the loader's catch, and the host rendered its own defaults — no site name, no
 * logo, no navigation — looking merely unconfigured.
 *
 * The site row also uses different column names from the zone row it replaced,
 * so the endpoint alone is not the fix: `site_name`, `site_logo_url`,
 * `primary_color` and a `sidebar | topbar | both` nav position have to reach
 * the layout in the vocabulary it reads.
 */
vi.mock('$app/environment', () => ({ browser: false }));
vi.mock('$lib/zveltio', () => ({ initZveltio: async () => {} }));

const { load } = await import('./+layout');

const site = {
  name: 'Fallback',
  site_name: 'Acme Portal',
  site_logo_url: '/logo.svg',
  primary_color: '#069494',
  secondary_color: null,
  custom_css: '.x{color:red}',
  nav_position: 'topbar',
};

let seen: string[];
function stub(status: number, body: unknown) {
  seen = [];
  return (async (url: string) => {
    seen.push(String(url));
    return { ok: status === 200, status, json: async () => body } as Response;
  }) as unknown as typeof fetch;
}

// The loader only reads `fetch` off its event; the rest of a real LoadEvent is
// not worth constructing to prove which URL it asks for.
const run = (f: typeof fetch) => load({ fetch: f } as Parameters<typeof load>[0]);

describe('root layout load', () => {
  beforeEach(() => {
    seen = [];
  });

  it('asks the sites endpoint, not the removed zones one', async () => {
    await run(stub(200, { site, nav: [] }));
    expect(seen[0]).toContain('/ext/content/pages/sites/client/render');
    expect(seen[0]).not.toContain('/api/zones');
  });

  it('maps the site row onto the vocabulary the layout reads', async () => {
    const data = await run(stub(200, { site, nav: [{ slug: 'about', title: 'About' }] }));
    expect(data.theme).toEqual({
      app_name: 'Acme Portal',
      logo_url: '/logo.svg',
      color_primary: '#069494',
      color_secondary: null,
      custom_css: '.x{color:red}',
      nav_position: 'top',
    });
    expect(data.nav).toEqual([{ slug: 'about', title: 'About' }]);
  });

  it('degrades to defaults when the site is not there', async () => {
    const data = await run(stub(404, {}));
    expect(data).toEqual({ theme: null, nav: [] });
  });
});
