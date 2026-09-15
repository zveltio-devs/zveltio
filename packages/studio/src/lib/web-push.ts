/**
 * The browser half of Web Push.
 *
 * Three things have to line up before a push can arrive, and all three fail
 * quietly on their own: the browser must support the Push API, the user must
 * grant permission, and the server must have VAPID keys. `webPushStatus()`
 * reports which one is missing so the UI can say so rather than showing a
 * toggle that does nothing.
 *
 * The service worker is `/push-sw.js` — a browser delivers a push only to a
 * worker, so the registration is not optional.
 */

import { api } from './api.js';

export type WebPushState =
  | 'unsupported' // no Push API in this browser
  | 'disabled-on-server' // no VAPID keys configured
  | 'denied' // the user refused, and only they can undo it
  | 'subscribed'
  | 'unsubscribed';

/** base64url → the Uint8Array `pushManager.subscribe` wants. */
function urlBase64ToUint8Array(base64url: string): Uint8Array {
  const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** An ArrayBuffer key from the Push API, as the engine stores it. */
function bufferToBase64Url(buf: ArrayBuffer | null): string {
  if (!buf) return '';
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function isSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window
  );
}

async function serverPublicKey(): Promise<string | null> {
  const res = await api.get<{ enabled: boolean; publicKey: string | null }>(
    '/api/notifications/push/vapid-public-key',
  );
  return res.enabled ? res.publicKey : null;
}

/** What to show the user, without changing anything. */
export async function webPushStatus(): Promise<WebPushState> {
  if (!isSupported()) return 'unsupported';
  if ((await serverPublicKey()) === null) return 'disabled-on-server';
  if (Notification.permission === 'denied') return 'denied';

  const reg = await navigator.serviceWorker.getRegistration('/push-sw.js');
  const existing = await reg?.pushManager.getSubscription();
  return existing ? 'subscribed' : 'unsubscribed';
}

/**
 * Subscribe this browser, and tell the engine about it.
 *
 * Returns the state the caller should now display. Permission is requested
 * here rather than earlier because a prompt the user did not ask for is the
 * fastest way to get a permanent `denied`, which nothing in the app can undo.
 */
export async function subscribeToWebPush(): Promise<WebPushState> {
  if (!isSupported()) return 'unsupported';

  const publicKey = await serverPublicKey();
  if (!publicKey) return 'disabled-on-server';

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'unsubscribed';

  const reg = await navigator.serviceWorker.register('/push-sw.js');
  await navigator.serviceWorker.ready;

  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      // Required by every browser: a push that any server could send would be
      // a push anyone could send.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    }));

  await api.post('/api/notifications/push/subscribe', {
    endpoint: sub.endpoint,
    p256dh: bufferToBase64Url(sub.getKey('p256dh')),
    auth: bufferToBase64Url(sub.getKey('auth')),
    user_agent: navigator.userAgent,
  });

  return 'subscribed';
}

/**
 * Unsubscribe this browser.
 *
 * The server row goes first: if the browser-side unsubscribe succeeded and the
 * DELETE then failed, the engine would keep sending to an endpoint that no
 * longer exists and only learn better from a 410.
 */
export async function unsubscribeFromWebPush(): Promise<WebPushState> {
  if (!isSupported()) return 'unsupported';

  const reg = await navigator.serviceWorker.getRegistration('/push-sw.js');
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return 'unsubscribed';

  await api.delete('/api/notifications/push/subscribe', { endpoint: sub.endpoint });
  await sub.unsubscribe();
  return 'unsubscribed';
}
