/**
 * Client server-side rendering (lib/client-ssr.ts, ADR 0005).
 *
 * A fake `_server/entry.js` stands in for the SvelteKit build, so these pin
 * the engine's half: what the render may reach, with whose credentials, and
 * when the caller falls back to the SPA shell.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { Hono } from 'hono';
import { isServerBundlePath, renderClient } from '../../lib/client-ssr.js';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A dist root whose server answers with `respond`'s body (a function of request, opts, env). */
function fakeDist(respond: string): string {
  const root = mkdtempSync(join(tmpdir(), 'client-ssr-'));
  roots.push(root);
  mkdirSync(join(root, '_server'));
  writeFileSync(
    join(root, '_server', 'entry.js'),
    `let env;
export const server = {
  async init(o) { env = o.env; },
  async respond(request, opts) { return (${respond})(request, opts, env); },
};`,
  );
  return root;
}

/** Calls renderClient from a real Hono route, so `c` is a real context. */
async function render(
  root: string,
  appFetch: (r: Request) => Response | Promise<Response>,
  headers: Record<string, string> = {},
) {
  const app = new Hono();
  app.get('/*', async (c) => (await renderClient(c, root, appFetch)) ?? c.text('SPA', 418));
  return app.request('http://site.test/page', { headers });
}

describe('renderClient', () => {
  it('answers /api and /ext in-process with the visitor credentials, whatever the load set', async () => {
    const root = fakeDist(`async (req, { platform }) => {
      const r = await platform.engineFetch(new Request('http://site.test/api/me', {
        headers: { cookie: 'forged=1', authorization: 'Bearer forged' },
      }));
      return new Response(await r.text(), { headers: { 'content-type': 'text/html' } });
    }`);
    const seen: string[] = [];
    const res = await render(
      root,
      (r) => {
        seen.push(new URL(r.url).pathname);
        return new Response(`${r.headers.get('cookie')}|${r.headers.get('authorization')}`);
      },
      { cookie: 'session=visitor' },
    );
    expect(await res.text()).toBe('session=visitor|null');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(seen).toEqual(['/api/me']);
  });

  it('passes a cookie the engine set during the render on to the visitor', async () => {
    const root = fakeDist(`async (req, { platform }) => {
      await platform.engineFetch(new Request('http://site.test/api/me'));
      return new Response('page', { headers: { 'set-cookie': 'theme=dark; Path=/' } });
    }`);
    const res = await render(root, () => {
      const h = new Headers();
      h.append('set-cookie', 'session=refreshed; Path=/; HttpOnly');
      return new Response('{}', { headers: h });
    });
    expect(res.headers.getSetCookie()).toEqual([
      'theme=dark; Path=/',
      'session=refreshed; Path=/; HttpOnly',
    ]);
  });

  it('refuses any other path, so a load cannot re-enter the renderer', async () => {
    const root = fakeDist(`async (req, { platform }) => {
      const r = await platform.engineFetch(new Request('http://site.test/admin/'));
      return new Response(String(r.status));
    }`);
    let called = false;
    const res = await render(root, () => {
      called = true;
      return new Response('');
    });
    expect(await res.text()).toBe('404');
    expect(called).toBe(false);
  });

  it('gives the render only PUBLIC_ variables', async () => {
    process.env.PUBLIC_SSR_TEST = 'visible';
    process.env.SSR_TEST_SECRET = 'hidden';
    const root = fakeDist('async (req, opts, env) => new Response(JSON.stringify(env))');
    const env = await (await render(root, () => new Response(''))).json();
    delete process.env.PUBLIC_SSR_TEST;
    delete process.env.SSR_TEST_SECRET;
    expect(env.PUBLIC_SSR_TEST).toBe('visible');
    expect(env.SSR_TEST_SECRET).toBeUndefined();
  });

  it('falls back to the SPA shell when the render throws or answers 5xx', async () => {
    const thrown = fakeDist('async () => { throw new Error("boom"); }');
    const failed = fakeDist('async () => new Response("error page", { status: 500 })');
    expect((await render(thrown, () => new Response(''))).status).toBe(418);
    expect((await render(failed, () => new Response(''))).status).toBe(418);
  });

  it('falls back when no server bundle was built', async () => {
    const root = mkdtempSync(join(tmpdir(), 'client-ssr-'));
    roots.push(root);
    expect((await render(root, () => new Response(''))).status).toBe(418);
  });
});

describe('isServerBundlePath', () => {
  // The static server decodes the URL and resolves it inside the dist root
  // first; these are the paths it ends up with.
  const root = resolve('/srv/client-dist');
  const at = (url: string) => resolve(root, decodeURIComponent(url).replace(/^\/+/, ''));

  it('refuses the bundle however the URL reaches it', () => {
    for (const url of [
      '/_server',
      '/_server/',
      '/_server/entry.js',
      '/x/..%2F_server/entry.js',
      '/%5Fserver/index.js',
    ]) {
      expect(isServerBundlePath(root, at(url))).toBe(true);
    }
  });

  it('leaves every other file alone', () => {
    for (const url of ['/', '/_app/immutable/x.js', '/_serverless.js', '/favicon.svg']) {
      expect(isServerBundlePath(root, at(url))).toBe(false);
    }
  });
});
