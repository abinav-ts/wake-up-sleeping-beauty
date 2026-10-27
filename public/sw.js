self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Pushes carry no payload; the server only nudges while an alarm is ringing.
self.addEventListener('push', (e) => {
  e.waitUntil(
    self.registration.showNotification('Wake up!', {
      body: 'Your alarm is ringing. Open to stop or snooze.',
      tag: 'alarm',
      renotify: true,
      requireInteraction: true,
      icon: '/icon-192.png',
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if ('focus' in c) return c.focus();
      return self.clients.openWindow('/');
    }),
  );
});
