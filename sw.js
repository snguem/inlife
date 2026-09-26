/* Service worker Inlife : hors ligne + rappels finances en arrière-plan */
const VERSION = 'inlife-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const FONT_CACHE = 'inlife-fonts';
const DATA_CACHE = 'inlife-data';
const REMINDERS_URL = './__reminders.json';

const SHELL = [
  './',
  './index.html',
  './inlife.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/badge-96.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k.startsWith('inlife-v') && k !== SHELL_CACHE)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Polices Google : servies depuis le cache, rafraîchies en arrière-plan
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(req, FONT_CACHE));
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Pages : réseau d'abord (pour recevoir les mises à jour), cache si hors ligne
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(url.pathname.endsWith('/') ? './' : req, copy));
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true })
          .then((r) => r || caches.match('./inlife.html')))
    );
    return;
  }

  // Fichiers de l'app : cache d'abord
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => cached || fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }))
  );
});

function staleWhileRevalidate(req, cacheName) {
  return caches.open(cacheName).then((cache) => cache.match(req).then((cached) => {
    const network = fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    }).catch(() => cached);
    return cached || network;
  }));
}

// ---------- Rappels ----------
function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function addDays(dk, n) {
  const d = new Date(dk + 'T00:00:00');
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function dueLabel(days) {
  if (days < 0) return `en retard de ${-days} j`;
  if (days === 0) return "aujourd'hui";
  if (days === 1) return 'demain';
  return `dans ${days} j`;
}

// Les échéances sont préparées par l'app dans le cache (le service worker n'a pas accès au localStorage)
async function checkReminders() {
  const cache = await caches.open(DATA_CACHE);
  const res = await cache.match(REMINDERS_URL);
  if (!res) return;
  const data = await res.json();
  const today = todayKey();
  if (data.lastNotified === today) return;
  const horizon = addDays(today, data.remindDays ?? 3);
  const due = (data.items || []).filter((it) => it.date <= horizon).sort((a, b) => a.date.localeCompare(b.date));
  if (!due.length) return;
  const days = (dk) => Math.round((new Date(dk + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000);
  await self.registration.showNotification('Rappels finances', {
    body: due.slice(0, 3).map((it) => `${it.text} (${dueLabel(days(it.date))})`).join('\n'),
    tag: 'inlife-finance',
    icon: './icons/icon-192.png',
    badge: './icons/badge-96.png',
    data: { url: './inlife.html?screen=finance' },
  });
  data.lastNotified = today;
  await cache.put(REMINDERS_URL, new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } }));
}

// Chrome/Edge sur Android, app installée : réveil périodique (environ une fois par jour, décidé par le navigateur)
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'inlife-reminders') event.waitUntil(checkReminders());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'check-reminders') event.waitUntil(checkReminders());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || './inlife.html', self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope) && 'focus' in c) {
        c.navigate(target);
        return c.focus();
      }
    }
    return self.clients.openWindow(target);
  }));
});
