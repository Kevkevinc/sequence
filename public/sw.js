/*
 * The background helper.
 *
 * A small script the phone keeps after the app is closed. It exists for one
 * reason here: a phone will only deliver a push notification to a site that has
 * registered one of these, so without it there is no way to tell a creator
 * their videos are ready. Renders take ten to fifteen minutes and nobody
 * watches a progress bar that long — they close the app and forget.
 *
 * Deliberately does not cache anything. An offline cache sounds like a free win
 * and is not: this app is a thin shell around a server that does all the work,
 * so a cached shell would show a creator a stale job list and a "new video"
 * form that cannot upload. Worse, a stale cached build is invisible — the app
 * would keep serving old code after a deploy, which is exactly the failure that
 * is hardest to diagnose from a bug report. Network-only keeps "what is
 * deployed" and "what the creator sees" the same thing.
 */

self.addEventListener('install', () => {
  // Take over immediately rather than waiting for every tab to close, so a
  // fixed version is live on the next open instead of some indeterminate later.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // A malformed push must still notify: the creator cares that something
    // finished, not about the shape of our JSON.
    payload = {};
  }

  const title = payload.title || 'Sequence';
  const options = {
    body: payload.body || 'Your videos are ready.',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    // Collapses repeats: three notifications for the same job would be noise.
    tag: payload.tag || 'sequence-job',
    renotify: true,
    data: { url: payload.url || '/jobs' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/jobs';

  /*
   * Focus an open window if there is one, rather than opening a second copy.
   * Tapping a notification and landing on a duplicate of the app you already
   * had open is the kind of small wrongness that makes a web app feel like a
   * web app.
   */
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if ('focus' in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
