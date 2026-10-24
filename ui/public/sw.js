// WhaLeads service worker: Web Push only. No caching on purpose: the app is staff-only and every screen is live data.
// Payload (src/push.ts): { title, body, url, tag }. `tag` collapses repeat notifications for the same chat or lead.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let p = null
  try { p = event.data ? event.data.json() : null } catch { p = null }
  if (!p || typeof p.title !== 'string') return
  event.waitUntil(
    self.registration.showNotification(p.title, {
      body: typeof p.body === 'string' ? p.body : '',
      tag: typeof p.tag === 'string' ? p.tag : undefined,
      renotify: typeof p.tag === 'string', // a newer message in the same chat should still alert
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: typeof p.url === 'string' ? p.url : '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  // Same-origin paths only: a crafted payload can never open an external page.
  let target = new URL('/', self.location.origin)
  try {
    const u = new URL(event.notification.data && event.notification.data.url, self.location.origin)
    if (u.origin === self.location.origin) target = u
  } catch { /* keep the app root */ }
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const open = wins.find((w) => new URL(w.url).origin === self.location.origin)
      if (open) {
        // Prefer navigate (keeps the installed window); fall back to focusing if the browser refuses.
        return (open.navigate ? open.navigate(target.href) : Promise.resolve(open)).then((c) => (c || open).focus()).catch(() => open.focus())
      }
      return self.clients.openWindow(target.href)
    }),
  )
})
