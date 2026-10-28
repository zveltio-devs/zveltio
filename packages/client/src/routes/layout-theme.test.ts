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
vi.mock('$app/env', () => ({ browser: false }));
vi.mock('#lib/zveltio.js', () => ({ initZveltio: async () => {} }));

const { load } = await import('./+layout');
const { themeName, themeStyle } = await import('@zveltio/ui/theme');

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
function stub(status: number, body: unknown, settings: unknown = {}) {
  seen = [];
  return (async (url: string) => {
    seen.push(String(url));
    if (String(url).includes('/api/settings/public')) {
      return { ok: true, status: 200, json: async () => settings } as Response;
    }
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
    expect(seen).toContainEqual(expect.stringContaining('/ext/content/pages/sites/client/render'));
    expect(seen.some((u) => u.includes('/api/zones'))).toBe(false);
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
    expect(data).toEqual({ tokens: null, theme: null, nav: [] });
  });
});

/**
 * Themes are data (ADR 0007): the tenant's theme comes from the public
 * settings, a site's two colours sit on top of it, and the kit turns it into
 * daisyUI's variables — dropping anything that is not a colour, a length or a
 * known name, since the result lands in a style attribute.
 */
describe('theme as data', () => {
  const tenant = {
    scheme: 'dark',
    colors: { primary: '#111111', accent: '#222222' },
    font: 'serif',
  };

  it('lays the site colours over the tenant theme', async () => {
    const data = await run(stub(200, { site, nav: [] }, { theme: tenant }));
    expect(data.tokens).toEqual({ ...tenant, colors: { primary: '#069494', accent: '#222222' } });
  });

  it('uses the tenant theme alone when there is no site', async () => {
    const data = await run(stub(404, {}, { theme: tenant }));
    expect(data.tokens).toEqual(tenant);
  });

  it('renders tokens as daisyUI variables', () => {
    expect(
      themeStyle({
        colors: { primary: 'oklch(62% 0.2 255)' },
        radius: { box: '1rem' },
        density: 'compact',
      }),
    ).toBe(
      '--color-primary:oklch(62% 0.2 255);--radius-box:1rem;--size-field:0.21875rem;--size-selector:0.21875rem',
    );
    expect(themeName({ scheme: 'dark' })).toBe('dark');
  });

  it('drops a value that could leave its declaration', () => {
    const hostile = {
      colors: { primary: 'red;background:url(https://x)', secondary: '#fff' },
      radius: { box: '1rem}body{display:none' },
      font: 'x;y' as never,
      scheme: 'dark;' as never,
    };
    expect(themeStyle(hostile)).toBe('--color-secondary:#fff');
    expect(themeName(hostile)).toBeUndefined();
  });
});
