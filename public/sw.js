// Network-first service worker: always prefer fresh content, fall back to the
// cache only when offline. Exists mainly to make the app installable.
const CACHE = 'bendit-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Reads worth keeping a copy of: without them the app has nothing to render
// when the network is gone. Writes are never cached — they go through the
// app's own queue instead.
const CACHEABLE_API = ['/api/day', '/api/profile', '/api/session', '/api/week', '/api/recents'];

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const { pathname } = new URL(request.url);

  if (pathname.startsWith('/api/')) {
    if (!CACHEABLE_API.some((p) => pathname === p || pathname.startsWith(p + '?'))) return;
    // Network first: the server is the truth whenever it can be reached.
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => caches.match(request).then((hit) => hit ?? Response.error())),
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request).then((hit) => hit ?? caches.match('/'))),
  );
});

// Reminders. The payload is small on purpose — the notification is a nudge to
// open the app, not a place to read data.
self.addEventListener('push', (event) => {
  let payload = { title: 'Bend It!', body: "Today isn't logged yet." };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // A malformed payload still deserves a notification, just the default one.
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icon-192.png',
      // A badge is drawn from its alpha channel and tinted by the system, so it
      // has to be a glyph on transparency. The app icon is an opaque square,
      // which arrives as a solid white block.
      badge: '/badge-96.png',
      tag: 'bendit-reminder',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const open = clients.find((c) => c.url.includes(self.location.origin));
      if (open) return open.focus();
      return self.clients.openWindow('/');
    }),
  );
});
