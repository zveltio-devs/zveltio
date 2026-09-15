/**
 * Service worker for Web Push.
 *
 * A browser will only deliver a push to a Service Worker, so this file is not
 * optional scaffolding — without it `pushManager.subscribe()` cannot be called
 * at all. It is deliberately the smallest thing that can receive a push: no
 * caching, no offline behaviour, no fetch handler. A service worker that
 * intercepts `fetch` changes how the whole app loads, and that is a decision
 * for whoever owns the Studio shell, not a side effect of adding notifications.
 *
 * Served from `static/`, so it is registered at `/push-sw.js` and its scope is
 * the site root — which is what a push subscription needs.
 */

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    // A push that is not ours, or a malformed one. Showing a notification with
    // raw bytes in it would be worse than showing nothing.
    return;
  }

  const title = payload.title || 'Zveltio';
  const options = {
    body: payload.body || '',
    icon: '/icon.svg',
    badge: '/icon.svg',
    // `data.url` is where a click goes; the engine puts the notification's
    // action_url here.
    data: { url: payload.data?.url || '/intranet/notifications' },
    // Same tag for every notification would collapse them into one; distinct
    // tags keep them separate in the tray.
    tag: payload.data?.tag,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/intranet/notifications';

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      // Focus a tab that is already open on this origin rather than opening a
      // second one — a notification that spawns a new tab every time is how
      // people end up with fifteen.
      for (const client of windows) {
        if ('focus' in client) {
          await client.focus();
          if ('navigate' in client) await client.navigate(target);
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(target);
    })(),
  );
});
