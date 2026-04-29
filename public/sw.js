// Minimal service worker — exists so Chrome treats the site as installable.
// No caching: this is a live dashboard and stale data would mislead users.

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', () => {
  // Pass-through. The presence of a fetch handler is what matters for installability.
})
