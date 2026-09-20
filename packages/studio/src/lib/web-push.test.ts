/**
 * The browser half of Web Push — specifically, the three ways it is off.
 *
 * Unsupported browser, no VAPID keys on the server, and a permission the user
 * refused all produce the same visible result: no notifications. They need
 * different words in the UI, and only one of them is fixable by the operator,
 * so the distinction is the whole point of this module.
 *
 * Nothing here talks to a real push service — there is no browser in this
 * process. What it pins is the decision table and the ORDER of the checks: the
 * permission prompt must come after the server key, or an install with no keys
 * asks for permission it cannot use and earns a permanent `denied`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSupported, subscribeToWebPush, unsubscribeFromWebPush, webPushStatus } from './web-push';
import { api } from './api';

// The real deployment mounts the Studio at /admin. The `$app/paths` stub under
// `tests/stubs` answers `base = ''`, and that is exactly why no test could see
// that the push worker was being registered at the site root — where the engine
// does not serve it.
vi.mock('$app/paths', () => ({ base: '/admin', assets: '' }));

const PUBLIC_KEY =
  'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';

type Mutable = Record<string, unknown>;
const g = globalThis as unknown as Mutable;

const saved = {
  navigator: g.navigator,
  Notification: g.Notification,
  PushManager: (globalThis as unknown as { window?: Mutable }).window?.PushManager,
  window: g.window,
};

/** A subscription as the Push API hands it over: keys are ArrayBuffers. */
function fakeSubscription(endpoint = 'https://push.example.com/abc') {
  return {
    endpoint,
    getKey: (name: string) => new Uint8Array(name === 'auth' ? 16 : 65).buffer,
    unsubscribe: vi.fn(async () => true),
  };
}

function installBrowser(opts: {
  permission?: NotificationPermission;
  existing?: ReturnType<typeof fakeSubscription> | null;
  subscribed?: ReturnType<typeof fakeSubscription>;
}) {
  const subscription = opts.existing ?? null;
  const registration = {
    pushManager: {
      getSubscription: vi.fn(async () => subscription),
      subscribe: vi.fn(async () => opts.subscribed ?? fakeSubscription()),
    },
  };
  const requestPermission = vi.fn(async () => opts.permission ?? 'granted');
  g.navigator = {
    userAgent: 'test-agent',
    serviceWorker: {
      register: vi.fn(async () => registration),
      getRegistration: vi.fn(async () => registration),
      ready: Promise.resolve(registration),
    },
  };
  g.window = { PushManager: function PushManager() {} };
  g.Notification = { permission: opts.permission ?? 'default', requestPermission };
  return { registration, requestPermission };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  g.navigator = saved.navigator;
  g.Notification = saved.Notification;
  g.window = saved.window;
});

describe('webPushStatus', () => {
  it('reports an unsupported browser without calling the server', async () => {
    g.navigator = {};
    g.window = {};
    const get = vi.spyOn(api, 'get');
    expect(isSupported()).toBe(false);
    expect(await webPushStatus()).toBe('unsupported');
    expect(get).not.toHaveBeenCalled();
  });

  it('reports the server having no keys', async () => {
    installBrowser({});
    vi.spyOn(api, 'get').mockResolvedValue({ enabled: false, publicKey: null });
    expect(await webPushStatus()).toBe('disabled-on-server');
  });

  it('reports a refusal the app cannot undo', async () => {
    installBrowser({ permission: 'denied' });
    vi.spyOn(api, 'get').mockResolvedValue({ enabled: true, publicKey: PUBLIC_KEY });
    expect(await webPushStatus()).toBe('denied');
  });

  it('distinguishes subscribed from unsubscribed', async () => {
    installBrowser({ permission: 'granted', existing: fakeSubscription() });
    vi.spyOn(api, 'get').mockResolvedValue({ enabled: true, publicKey: PUBLIC_KEY });
    expect(await webPushStatus()).toBe('subscribed');

    installBrowser({ permission: 'granted', existing: null });
    vi.spyOn(api, 'get').mockResolvedValue({ enabled: true, publicKey: PUBLIC_KEY });
    expect(await webPushStatus()).toBe('unsubscribed');
  });
});

describe('subscribeToWebPush', () => {
  it('sends the endpoint and both keys as base64url', async () => {
    installBrowser({ permission: 'granted', existing: null });
    vi.spyOn(api, 'get').mockResolvedValue({ enabled: true, publicKey: PUBLIC_KEY });
    const post = vi.spyOn(api, 'post').mockResolvedValue({ success: true });

    expect(await subscribeToWebPush()).toBe('subscribed');

    const [path, body] = post.mock.calls[0] as [string, Record<string, string>];
    expect(path).toBe('/api/notifications/push/subscribe');
    expect(body.endpoint).toBe('https://push.example.com/abc');
    // The engine validates these lengths and refuses anything else, so a
    // base64url slip here is a 400 at subscribe time.
    expect(body.p256dh).toMatch(/^[\w-]+$/);
    expect(atob(body.p256dh.replace(/-/g, '+').replace(/_/g, '/')).length).toBe(65);
    expect(atob(body.auth.replace(/-/g, '+').replace(/_/g, '/')).length).toBe(16);
  });

  it('does NOT ask for permission when the server has no keys', async () => {
    // Order matters: a prompt the user cannot benefit from is the fastest way
    // to earn a permanent `denied`, and nothing in the app can undo that.
    const { requestPermission } = installBrowser({});
    vi.spyOn(api, 'get').mockResolvedValue({ enabled: false, publicKey: null });
    const post = vi.spyOn(api, 'post');

    expect(await subscribeToWebPush()).toBe('disabled-on-server');
    expect(requestPermission).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('tells the server nothing when the user refuses', async () => {
    installBrowser({ permission: 'denied' });
    vi.spyOn(api, 'get').mockResolvedValue({ enabled: true, publicKey: PUBLIC_KEY });
    const post = vi.spyOn(api, 'post');

    expect(await subscribeToWebPush()).toBe('denied');
    expect(post).not.toHaveBeenCalled();
  });
});

describe('unsubscribeFromWebPush', () => {
  it('removes the server row before the browser subscription', async () => {
    const sub = fakeSubscription();
    installBrowser({ permission: 'granted', existing: sub });
    const order: string[] = [];
    vi.spyOn(api, 'delete').mockImplementation(async () => {
      order.push('server');
      return {};
    });
    sub.unsubscribe.mockImplementation(async () => {
      order.push('browser');
      return true;
    });

    expect(await unsubscribeFromWebPush()).toBe('unsubscribed');
    // The other order leaves the engine sending to an endpoint that is gone
    // until a 410 teaches it otherwise.
    expect(order).toEqual(['server', 'browser']);
  });

  it('is a no-op when there is nothing subscribed', async () => {
    installBrowser({ permission: 'granted', existing: null });
    const del = vi.spyOn(api, 'delete');
    expect(await unsubscribeFromWebPush()).toBe('unsubscribed');
    expect(del).not.toHaveBeenCalled();
  });
});

describe('web push — where the service worker is', () => {
  it('registers the worker under the Studio base path, not at the site root', async () => {
    // `static/push-sw.js` is built into the Studio's dist, and the engine serves
    // that tree under `/admin/*` only — the site root is the public web host,
    // whose static directory has no such file. Registering `/push-sw.js` 404s on
    // every embedded install, which is the default one, so subscribing failed
    // before it ever reached the engine.
    installBrowser({ permission: 'granted', existing: null });
    vi.spyOn(api, 'get').mockResolvedValue({ enabled: true, publicKey: PUBLIC_KEY });
    vi.spyOn(api, 'post').mockResolvedValue({ success: true });

    expect(await subscribeToWebPush()).toBe('subscribed');

    const sw = (g.navigator as { serviceWorker: { register: ReturnType<typeof vi.fn> } })
      .serviceWorker;
    expect(sw.register).toHaveBeenCalledWith('/admin/push-sw.js');
  });

  it('looks for the existing registration at the same path', async () => {
    // Two call sites read it and one call site writes it. A path fixed in the
    // writer and left in a reader reports `unsubscribed` for a browser that is
    // in fact subscribed.
    installBrowser({ permission: 'granted', existing: fakeSubscription() });
    vi.spyOn(api, 'get').mockResolvedValue({ enabled: true, publicKey: PUBLIC_KEY });

    expect(await webPushStatus()).toBe('subscribed');

    const sw = (g.navigator as { serviceWorker: { getRegistration: ReturnType<typeof vi.fn> } })
      .serviceWorker;
    expect(sw.getRegistration).toHaveBeenCalledWith('/admin/push-sw.js');
  });
});
