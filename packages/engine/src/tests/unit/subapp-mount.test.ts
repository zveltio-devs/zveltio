import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';

/**
 * Verifies the Hono mount semantics that S3-01 relies on:
 *   - `app.route('/ext/<name>', subApp)` exposes the sub-app's routes under
 *     the prefix.
 *   - Routes registered with relative paths on the sub-app respond correctly.
 *   - Disabling an extension means rebuilding the outer app WITHOUT mounting
 *     its sub-app — the routes disappear.
 *
 * These tests run Hono in isolation (no engine bootstrap, no DB). They exist
 * to catch regressions in the mount pattern itself.
 */

describe('S3-01: sub-app mount semantics', () => {
  it('mounts a sub-app and routes its requests via the prefix', async () => {
    const subApp = new Hono();
    subApp.get('/', (c) => c.json({ where: 'root' }));
    subApp.get('/:id', (c) => c.json({ where: 'single', id: c.req.param('id') }));

    const outer = new Hono();
    outer.route('/ext/forms', subApp);

    const root = await outer.request('/ext/forms');
    expect(root.status).toBe(200);
    expect(await root.json()).toEqual({ where: 'root' });

    const single = await outer.request('/ext/forms/abc');
    expect(single.status).toBe(200);
    expect(await single.json()).toEqual({ where: 'single', id: 'abc' });
  });

  it('supports slash-bearing extension names (e.g. communications/mail)', async () => {
    const subApp = new Hono();
    subApp.get('/messages', (c) => c.json({ ok: true }));

    const outer = new Hono();
    outer.route('/ext/communications/mail', subApp);

    const res = await outer.request('/ext/communications/mail/messages');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns 404 for paths outside the mounted prefix', async () => {
    const subApp = new Hono();
    subApp.get('/items', (c) => c.json({}));

    const outer = new Hono();
    outer.route('/ext/forms', subApp);

    const res = await outer.request('/ext/other/items');
    expect(res.status).toBe(404);
  });

  it('preserves the sub-app middleware when invoked via the mount', async () => {
    const subApp = new Hono();
    let middlewareRan = false;
    subApp.use('*', async (_c, next) => {
      middlewareRan = true;
      await next();
    });
    subApp.get('/x', (c) => c.text('hi'));

    const outer = new Hono();
    outer.route('/ext/forms', subApp);

    await outer.request('/ext/forms/x');
    expect(middlewareRan).toBe(true);
  });

  it('disable-then-rebuild: a fresh outer without the sub-app returns 404', async () => {
    // Simulates what `triggerReload()` does — build a new outer, skip the
    // extension being disabled.
    const subApp = new Hono();
    subApp.get('/items', (c) => c.json({ items: [] }));

    const outer1 = new Hono();
    outer1.route('/ext/forms', subApp);
    expect((await outer1.request('/ext/forms/items')).status).toBe(200);

    // Now the engine "disables" forms: build a new outer WITHOUT mounting it.
    const outer2 = new Hono();
    expect((await outer2.request('/ext/forms/items')).status).toBe(404);
  });

  it('two extensions under /ext/<name> do not collide', async () => {
    const formsSub = new Hono();
    formsSub.get('/', (c) => c.text('forms'));

    const smsSub = new Hono();
    smsSub.get('/messages', (c) => c.text('sms messages'));

    const outer = new Hono();
    outer.route('/ext/forms', formsSub);
    outer.route('/ext/sms', smsSub);

    expect(await (await outer.request('/ext/forms')).text()).toBe('forms');
    expect(await (await outer.request('/ext/sms/messages')).text()).toBe('sms messages');
  });

  it('public escape-hatch route lives outside /ext/<name> on the global app', async () => {
    // Mirrors what registerPublicRoute does internally: extension's sub-app
    // is mounted at /ext/<name>, but the engine also registers a route
    // directly on the outer app at a fixed path (e.g. /share/:token).
    const subApp = new Hono();
    subApp.get('/files', (c) => c.json({ files: [] }));

    const outer = new Hono();
    outer.route('/ext/storage/cloud', subApp);
    // Simulate registerPublicRoute({ method: 'GET', path: '/share/:token', ... })
    outer.get('/share/:token', (c) => c.json({ token: c.req.param('token'), public: true }));

    // Sub-app routes work as before.
    expect((await outer.request('/ext/storage/cloud/files')).status).toBe(200);

    // Public route reachable at the global path, NOT under /ext/.
    const res = await outer.request('/share/abc123');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: 'abc123', public: true });

    // And not at the would-be sub-app path.
    expect((await outer.request('/ext/storage/cloud/share/abc123')).status).toBe(404);
  });
});
